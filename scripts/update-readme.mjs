// Generates README.md from TEMPLATE.md using live data from the GitHub GraphQL API.
// Runs in GitHub Actions with the default GITHUB_TOKEN (public data only) and needs no dependencies.
import { readFileSync, writeFileSync } from "node:fs";

const login = process.env.PROFILE_LOGIN || process.env.GITHUB_REPOSITORY_OWNER;
const token = process.env.GITHUB_TOKEN;
if (!login || !token) {
    throw new Error("PROFILE_LOGIN (or GITHUB_REPOSITORY_OWNER) and GITHUB_TOKEN are required.");
}

async function graphql(query) {
    const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": login },
        body: JSON.stringify({ query }),
    });
    const json = await response.json();
    if (!response.ok || json.errors) {
        throw new Error(`GraphQL request failed: ${JSON.stringify(json.errors ?? json)}`);
    }
    return json.data;
}

// 1. Profile, repositories (all pages), languages
const repositories = [];
let cursor = null;
let user;
do {
    const after = cursor ? `, after: "${cursor}"` : "";
    const data = await graphql(`{
        user(login: "${login}") {
            createdAt
            issues { totalCount }
            pullRequests { totalCount }
            repositoriesContributedTo(contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]) { totalCount }
            contributionsCollection { contributionYears }
            repositories(first: 100, ownerAffiliations: OWNER, isFork: false${after}) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes { stargazerCount isArchived primaryLanguage { name color } }
            }
        }
    }`);
    user = data.user;
    repositories.push(...user.repositories.nodes);
    cursor = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
} while (cursor);

// 2. Commits and code reviews, summed over every contribution year
const years = user.contributionsCollection.contributionYears;
const perYear = await graphql(`{
    user(login: "${login}") {
        ${years.map((y) => `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y + 1}-01-01T00:00:00Z") {
            totalCommitContributions
            restrictedContributionsCount
            totalPullRequestReviewContributions
        }`).join("\n")}
    }
}`);
let commits = 0;
let codeReviews = 0;
for (const y of years) {
    const c = perYear.user[`y${y}`];
    commits += c.totalCommitContributions + c.restrictedContributionsCount;
    codeReviews += c.totalPullRequestReviewContributions;
}

// 3. Derived values
const stars = repositories.reduce((sum, r) => sum + r.stargazerCount, 0);
const accountAge = Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (365.25 * 24 * 3600 * 1000));
const languageCounts = new Map();
for (const r of repositories) {
    if (!r.primaryLanguage || r.isArchived) continue;
    const entry = languageCounts.get(r.primaryLanguage.name) ?? { name: r.primaryLanguage.name, color: r.primaryLanguage.color ?? "#555555", count: 0 };
    entry.count++;
    languageCounts.set(entry.name, entry);
}
const languageTotal = [...languageCounts.values()].reduce((s, l) => s + l.count, 0);
const languages = [...languageCounts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((l) => ({ ...l, percent: (100 * l.count / languageTotal).toFixed(1) }));

const number = (n) => n.toLocaleString("en-US");
const values = {
    REPOSITORIES: number(user.repositories.totalCount),
    STARS: number(stars),
    COMMITS: number(commits),
    PULL_REQUESTS: number(user.pullRequests.totalCount),
    CODE_REVIEWS: number(codeReviews),
    ISSUES: number(user.issues.totalCount),
    REPOSITORIES_CONTRIBUTED_TO: number(user.repositoriesContributedTo.totalCount),
    ACCOUNT_AGE: number(accountAge),
    UPDATED: new Date().toISOString().slice(0, 10),
};

// 4. Render the template
let output = readFileSync("TEMPLATE.md", "utf8");

output = output.replace(
    /\{\{\s*LANGUAGE_TEMPLATE_START(?::max=(\d+))?\s*\}\}([\s\S]*?)\{\{\s*LANGUAGE_TEMPLATE_END\s*\}\}/g,
    (_, max, inner) => languages
        .slice(0, max ? Number(max) : languages.length)
        .map((l) => inner.replace(/\{\{\s*LANGUAGE_(NAME|PERCENT|COLOR)(:uri)?\s*\}\}/g, (__, key, uri) => {
            const value = { NAME: l.name, PERCENT: l.percent, COLOR: l.color }[key];
            return uri ? encodeURIComponent(value) : value;
        }))
        .join(""),
);

output = output.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`Unknown template variable ${match}`);
    return values[key];
});

writeFileSync("README.md", output);
console.log(JSON.stringify({ ...values, languages: languages.slice(0, 6).map((l) => `${l.name} ${l.percent}%`) }, null, 2));
