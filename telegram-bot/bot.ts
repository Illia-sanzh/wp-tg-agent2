import { Bot, Context, session, SessionFlavor } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import axios from "axios";
import FormData from "form-data";
import * as yaml from "js-yaml";

const HTTPS_PROXY = process.env.HTTPS_PROXY ?? "";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

function sanitize(text: string): string {
  return text.replaceAll(TELEGRAM_BOT_TOKEN, "[REDACTED]");
}

const ADMIN_USER_IDS = new Set<number>(
  (process.env.TELEGRAM_ADMIN_USER_ID ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => parseInt(s, 10))
    .filter(n => !isNaN(n)),
);

const AGENT_URL     = process.env.AGENT_URL     ?? "http://openclaw-agent:8080";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "claude-sonnet-4-6";
const AUTO_ROUTING  = (process.env.AUTO_ROUTING ?? "false").toLowerCase() === "true";
const FAST_MODEL    = process.env.FAST_MODEL    ?? "claude-haiku-4-5";
const SMART_MODEL   = process.env.SMART_MODEL   ?? DEFAULT_MODEL;

interface ChatMessage { role: string; content: string; }

interface SessionData {
  model?:               string;
  history?:             ChatMessage[];
  skillStep?:           string;
  skillDraft?:          Record<string, any>;
  pendingSkillDelete?:  string;
  mcpStep?:             string;
  mcpDraft?:            Record<string, any>;
}

type MyContext = Context & SessionFlavor<SessionData>;

const KNOWN_MODELS = new Set([
  "auto",
  "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6",
  "gpt-4o", "gpt-4o-mini",
  "deepseek-chat", "deepseek-reasoner",
  "gemini-2.0-flash",
  "openrouter/claude-sonnet-4-6", "openrouter/claude-haiku-4-5", "openrouter/claude-opus-4-6",
  "openrouter/gpt-4o", "openrouter/gpt-4o-mini",
  "openrouter/gemini-2.0-flash",
  "openrouter/deepseek-chat", "openrouter/deepseek-r1",
  "openrouter/llama-3.3-70b", "openrouter/mistral-large",
  "openrouter/gemma-3-27b", "openrouter/qwq-32b",
]);

function isValidModel(name: string): boolean {
  return KNOWN_MODELS.has(name) || name.startsWith("openrouter/");
}

interface EnvDef { name: string; hint: string; required: boolean; }
interface McpEntry { package: string; description: string; category: string; env: EnvDef[]; }

const MCP_CATALOG: Record<string, McpEntry> = {

  "server-fetch": {
    package: "@modelcontextprotocol/server-fetch",
    description: "Fetch any URL and convert to clean markdown",
    category: "Utility",
    env: [],
  },
  "server-memory": {
    package: "@modelcontextprotocol/server-memory",
    description: "Persistent key-value knowledge graph between sessions",
    category: "Utility",
    env: [],
  },
  "server-filesystem": {
    package: "@modelcontextprotocol/server-filesystem",
    description: "Read, write and search files in allowed directories",
    category: "Utility",
    env: [],
  },
  "server-sequentialthinking": {
    package: "@modelcontextprotocol/server-sequentialthinking",
    description: "Dynamic step-by-step reasoning with reflection",
    category: "Utility",
    env: [],
  },
  "server-time": {
    package: "@modelcontextprotocol/server-time",
    description: "Current time, timezone conversion",
    category: "Utility",
    env: [],
  },
  "server-everything": {
    package: "@modelcontextprotocol/server-everything",
    description: "Reference/test server — useful for debugging",
    category: "Utility",
    env: [],
  },

  "server-postgres": {
    package: "@modelcontextprotocol/server-postgres",
    description: "Query and inspect PostgreSQL databases",
    category: "Database",
    env: [
      { name: "POSTGRES_URL", hint: "Full connection string, e.g. postgresql://user:pass@host:5432/dbname", required: true },
    ],
  },
  "server-sqlite": {
    package: "@modelcontextprotocol/server-sqlite",
    description: "Read/write SQLite databases on the local filesystem",
    category: "Database",
    env: [],
  },
  "supabase": {
    package: "@supabase/mcp-server-supabase",
    description: "Manage Supabase projects, databases, storage and edge functions",
    category: "Database",
    env: [
      { name: "SUPABASE_ACCESS_TOKEN", hint: "Personal access token from app.supabase.com/account/tokens", required: true },
    ],
  },
  "qdrant": {
    package: "@qdrant/mcp-server-qdrant",
    description: "Store and query vector embeddings for semantic memory",
    category: "Database",
    env: [
      { name: "QDRANT_URL",     hint: "Your Qdrant instance URL, e.g. http://localhost:6333 or cloud URL", required: true },
      { name: "QDRANT_API_KEY", hint: "Qdrant Cloud API key (skip for local instances)",                  required: false },
    ],
  },
  "duckdb": {
    package: "@motherduck/mcp-server-duckdb",
    description: "Query DuckDB and MotherDuck cloud warehouse",
    category: "Database",
    env: [
      { name: "motherduck_token", hint: "MotherDuck token from app.motherduck.com (optional for local DuckDB)", required: false },
    ],
  },

  "brave-search": {
    package: "@brave/brave-search-mcp-server",
    description: "Web, news, image and video search via Brave Search API",
    category: "Search",
    env: [
      { name: "BRAVE_API_KEY", hint: "API key from brave.com/search/api — free tier available", required: true },
    ],
  },
  "tavily": {
    package: "tavily-mcp",
    description: "AI-optimised web search, extract, crawl (great for research)",
    category: "Search",
    env: [
      { name: "TAVILY_API_KEY", hint: "API key from app.tavily.com — free tier includes 1 000 req/month", required: true },
    ],
  },
  "exa": {
    package: "exa-mcp-server",
    description: "Neural web search — academic papers, LinkedIn, real-time results",
    category: "Search",
    env: [
      { name: "EXA_API_KEY", hint: "API key from exa.ai/api — free trial available", required: true },
    ],
  },
  "firecrawl": {
    package: "@mendable/firecrawl-mcp",
    description: "Advanced web scraping, crawling and structured data extraction",
    category: "Search",
    env: [
      { name: "FIRECRAWL_API_KEY", hint: "API key from firecrawl.dev — free tier available", required: true },
    ],
  },
  "server-google-maps": {
    package: "@modelcontextprotocol/server-google-maps",
    description: "Geocoding, directions, place search via Google Maps",
    category: "Search",
    env: [
      { name: "GOOGLE_MAPS_API_KEY", hint: "API key from console.cloud.google.com — enable Maps JavaScript API", required: true },
    ],
  },

  "server-github": {
    package: "@modelcontextprotocol/server-github",
    description: "GitHub repos, issues, PRs, file search, code review",
    category: "Developer",
    env: [
      { name: "GITHUB_PERSONAL_ACCESS_TOKEN", hint: "Classic token from github.com/settings/tokens — needs repo + read:org", required: true },
    ],
  },
  "cloudflare": {
    package: "@cloudflare/mcp-server-cloudflare",
    description: "Manage Cloudflare Workers, KV, R2, D1, DNS zones",
    category: "Developer",
    env: [
      { name: "CLOUDFLARE_API_TOKEN",  hint: "API token from dash.cloudflare.com/profile/api-tokens",          required: true },
      { name: "CLOUDFLARE_ACCOUNT_ID", hint: "Account ID from the right sidebar of your Cloudflare dashboard", required: true },
    ],
  },
  "sentry": {
    package: "@sentry/mcp-server",
    description: "Query Sentry errors, issues, releases and performance data",
    category: "Developer",
    env: [
      { name: "SENTRY_AUTH_TOKEN", hint: "Auth token from sentry.io/settings/account/api/auth-tokens/", required: true },
      { name: "SENTRY_ORG",        hint: "Your Sentry organisation slug (shown in URL: sentry.io/organizations/<slug>)", required: false },
    ],
  },
  "vercel": {
    package: "@open-mcp/vercel",
    description: "Manage Vercel deployments, projects, domains and env vars",
    category: "Developer",
    env: [
      { name: "VERCEL_API_KEY", hint: "Token from vercel.com/account/tokens", required: true },
    ],
  },

  "notion": {
    package: "@notionhq/notion-mcp-server",
    description: "Search, read and write Notion pages and databases",
    category: "Productivity",
    env: [
      { name: "NOTION_TOKEN", hint: "Integration token from notion.so/profile/integrations — create an internal integration", required: true },
    ],
  },
  "linear": {
    package: "linear-mcp-server",
    description: "Create and manage Linear issues, projects and cycles",
    category: "Productivity",
    env: [
      { name: "LINEAR_API_KEY", hint: "Personal API key from linear.app/settings/api", required: true },
    ],
  },

  "server-slack": {
    package: "@modelcontextprotocol/server-slack",
    description: "Read/write Slack messages, list channels, manage threads",
    category: "Communication",
    env: [
      { name: "SLACK_BOT_TOKEN", hint: "Bot User OAuth token (xoxb-...) from api.slack.com/apps > OAuth & Permissions", required: true },
      { name: "SLACK_TEAM_ID",   hint: "Workspace ID starting with T — shown in workspace URL or admin panel",            required: true },
    ],
  },

  "stripe": {
    package: "@stripe/mcp",
    description: "Query Stripe customers, payments, subscriptions and webhooks",
    category: "Payments",
    env: [
      { name: "STRIPE_SECRET_KEY", hint: "Secret key from dashboard.stripe.com/apikeys — use test key (sk_test_...) first", required: true },
    ],
  },
  "shopify": {
    package: "shopify-mcp-server",
    description: "Manage Shopify products, orders, customers and collections",
    category: "Payments",
    env: [
      { name: "SHOPIFY_ACCESS_TOKEN", hint: "Admin API access token from your Shopify app settings", required: true },
      { name: "MYSHOPIFY_DOMAIN",     hint: "Your store domain, e.g. mystore.myshopify.com",        required: true },
    ],
  },

  "server-puppeteer": {
    package: "@modelcontextprotocol/server-puppeteer",
    description: "Browser automation — navigate, screenshot, click, fill forms",
    category: "Browser",
    env: [],
  },
  "playwright": {
    package: "@playwright/mcp",
    description: "Browser automation via Playwright (Microsoft) — headless testing & scraping",
    category: "Browser",
    env: [],
  },
  "browserbase": {
    package: "@browserbasehq/mcp-server-browserbase",
    description: "Cloud browser automation with Stagehand — scalable headless browsers",
    category: "Browser",
    env: [
      { name: "BROWSERBASE_API_KEY",    hint: "API key from browserbase.com/settings", required: true },
      { name: "BROWSERBASE_PROJECT_ID", hint: "Project ID from your Browserbase dashboard", required: true },
    ],
  },

  "server-redis": {
    package: "@modelcontextprotocol/server-redis",
    description: "Redis key-value store — get, set, list, delete keys",
    category: "Database",
    env: [
      { name: "REDIS_URL", hint: "Redis connection URL, e.g. redis://localhost:6379", required: false },
    ],
  },
  "mysql": {
    package: "@benborla29/mcp-server-mysql",
    description: "Query and manage MySQL databases with permissions and backup support",
    category: "Database",
    env: [
      { name: "MYSQL_HOST",     hint: "Database hostname, e.g. localhost or db.example.com", required: true },
      { name: "MYSQL_USER",     hint: "Database username",                                    required: true },
      { name: "MYSQL_PASSWORD", hint: "Database password",                                    required: true },
      { name: "MYSQL_DATABASE", hint: "Default database name",                                required: true },
    ],
  },
  "mongodb": {
    package: "@mongodb-js/mongodb-mcp-server",
    description: "Query and manage MongoDB databases and collections",
    category: "Database",
    env: [
      { name: "MONGODB_URI", hint: "Connection string, e.g. mongodb+srv://user:pass@cluster.mongodb.net/dbname", required: true },
    ],
  },
  "neon": {
    package: "@neondatabase/mcp-server-neon",
    description: "Neon serverless Postgres — manage branches, databases, roles",
    category: "Database",
    env: [
      { name: "NEON_API_KEY", hint: "API key from console.neon.tech/app/settings/api-keys", required: true },
    ],
  },
  "pinecone": {
    package: "@pinecone-database/mcp",
    description: "Pinecone vector database — create indexes, upsert & query embeddings",
    category: "Database",
    env: [
      { name: "PINECONE_API_KEY", hint: "API key from app.pinecone.io", required: true },
    ],
  },
  "upstash": {
    package: "@upstash/mcp-server",
    description: "Upstash serverless Redis, Kafka & QStash management",
    category: "Database",
    env: [
      { name: "UPSTASH_EMAIL",   hint: "Email associated with your Upstash account",        required: true },
      { name: "UPSTASH_API_KEY", hint: "Management API key from console.upstash.com/account", required: true },
    ],
  },
  "elasticsearch": {
    package: "@elastic/mcp-server-elasticsearch",
    description: "Search, index and manage Elasticsearch clusters",
    category: "Database",
    env: [
      { name: "ES_URL",     hint: "Elasticsearch URL, e.g. https://my-cluster.es.cloud:9243", required: true },
      { name: "ES_API_KEY", hint: "API key from Kibana > Stack Management > API Keys",         required: true },
    ],
  },
  "bigquery": {
    package: "@ergut/mcp-bigquery-server",
    description: "Query and explore Google BigQuery datasets and tables",
    category: "Database",
    env: [
      { name: "GOOGLE_APPLICATION_CREDENTIALS", hint: "Path to service account JSON key file", required: true },
      { name: "BIGQUERY_PROJECT_ID",            hint: "Google Cloud project ID",               required: true },
    ],
  },
  "turso": {
    package: "@prama13/turso-mcp",
    description: "Query Turso / libSQL edge databases (read-only, safe for AI)",
    category: "Database",
    env: [
      { name: "TURSO_DATABASE_URL", hint: "libSQL URL, e.g. libsql://mydb-myorg.turso.io", required: true },
      { name: "TURSO_AUTH_TOKEN",   hint: "Auth token from Turso dashboard",                 required: true },
    ],
  },

  "server-gdrive": {
    package: "@modelcontextprotocol/server-gdrive",
    description: "Read, search and manage Google Drive files and folders",
    category: "Cloud",
    env: [
      { name: "GDRIVE_CREDENTIALS", hint: "OAuth 2.0 credentials JSON — see Google Cloud Console > APIs > Credentials", required: true },
    ],
  },
  "server-aws-kb": {
    package: "@modelcontextprotocol/server-aws-kb-retrieval",
    description: "Query AWS Bedrock knowledge bases for RAG retrieval",
    category: "Cloud",
    env: [
      { name: "AWS_ACCESS_KEY_ID",     hint: "IAM access key with Bedrock permissions",       required: true },
      { name: "AWS_SECRET_ACCESS_KEY", hint: "IAM secret key",                                 required: true },
      { name: "AWS_REGION",            hint: "AWS region, e.g. us-east-1",                     required: true },
    ],
  },
  "azure": {
    package: "@azure/mcp",
    description: "Manage Azure resources — Storage, CosmosDB, App Service, and more",
    category: "Cloud",
    env: [
      { name: "AZURE_SUBSCRIPTION_ID", hint: "Subscription ID from Azure Portal", required: true },
    ],
  },
  "aws-s3": {
    package: "aws-s3-mcp",
    description: "Manage AWS S3 buckets and objects — upload, download, list, delete",
    category: "Cloud",
    env: [
      { name: "AWS_ACCESS_KEY_ID",     hint: "IAM access key with S3 permissions", required: true },
      { name: "AWS_SECRET_ACCESS_KEY", hint: "IAM secret key",                      required: true },
      { name: "AWS_REGION",            hint: "AWS region, e.g. us-east-1",          required: true },
    ],
  },
  "dropbox": {
    package: "@microagents/mcp-server-dropbox",
    description: "Access and manage Dropbox files and folders",
    category: "Cloud",
    env: [
      { name: "DROPBOX_ACCESS_TOKEN", hint: "Access token from dropbox.com/developers/apps", required: true },
    ],
  },
  "box": {
    package: "box-mcp-server",
    description: "Interact with Box cloud content — files, folders, search",
    category: "Cloud",
    env: [
      { name: "BOX_CLIENT_ID",     hint: "OAuth client ID from Box Developer Console",     required: true },
      { name: "BOX_CLIENT_SECRET", hint: "OAuth client secret from Box Developer Console", required: true },
    ],
  },

  "server-gitlab": {
    package: "@modelcontextprotocol/server-gitlab",
    description: "GitLab repos, merge requests, issues, CI pipelines",
    category: "Developer",
    env: [
      { name: "GITLAB_PERSONAL_ACCESS_TOKEN", hint: "Token from gitlab.com/-/user_settings/personal_access_tokens",  required: true },
      { name: "GITLAB_API_URL",               hint: "API base URL — default: https://gitlab.com/api/v4 (optional)", required: false },
    ],
  },
  "bitbucket": {
    package: "@atlassian-mcp-server/bitbucket",
    description: "Bitbucket repos, pull requests, branches and pipelines",
    category: "Developer",
    env: [
      { name: "BITBUCKET_USERNAME",     hint: "Atlassian account username/email",                       required: true },
      { name: "BITBUCKET_APP_PASSWORD", hint: "App password from bitbucket.org/account/settings/app-passwords", required: true },
    ],
  },
  "kubernetes": {
    package: "kubernetes-mcp-server",
    description: "Manage Kubernetes & OpenShift clusters — pods, deployments, services",
    category: "Developer",
    env: [
      { name: "KUBECONFIG", hint: "Path to kubeconfig file (optional, uses default if not set)", required: false },
    ],
  },
  "terraform": {
    package: "terraform-mcp-server",
    description: "Query Terraform Registry — providers, resources, modules, docs",
    category: "Developer",
    env: [],
  },
  "datadog": {
    package: "datadog-mcp-server",
    description: "Search Datadog logs, metrics, dashboards, monitors and events",
    category: "Developer",
    env: [
      { name: "DD_API_KEY", hint: "API key from app.datadoghq.com/organization-settings/api-keys", required: true },
      { name: "DD_APP_KEY", hint: "Application key from the same settings page",                     required: true },
    ],
  },
  "circleci": {
    package: "@circleci/mcp-server-circleci",
    description: "CircleCI build logs, flaky test detection, pipeline insights",
    category: "Developer",
    env: [
      { name: "CIRCLECI_TOKEN", hint: "Personal API token from circleci.com/account/api", required: true },
    ],
  },
  "openapi": {
    package: "openapi-mcp-server",
    description: "Explore any OpenAPI/Swagger spec — discover endpoints and schemas",
    category: "Developer",
    env: [],
  },
  "commands": {
    package: "mcp-server-commands",
    description: "Run shell commands and scripts from the AI agent",
    category: "Developer",
    env: [],
  },
  "docker": {
    package: "@0xshariq/docker-mcp-server",
    description: "Docker container, image, volume and network management (16 tools)",
    category: "Developer",
    env: [],
  },

  "perplexity": {
    package: "@perplexity-ai/mcp-server",
    description: "Perplexity AI search — real-time web search with reasoning and citations",
    category: "Search",
    env: [
      { name: "PERPLEXITY_API_KEY", hint: "API key from perplexity.ai/settings/api", required: true },
    ],
  },
  "typesense": {
    package: "typesense-mcp-server",
    description: "Typesense instant search — discover, search and analyse collections",
    category: "Search",
    env: [
      { name: "TYPESENSE_API_KEY", hint: "API key from your Typesense Cloud cluster or self-hosted instance", required: true },
      { name: "TYPESENSE_HOST",    hint: "Typesense host, e.g. xyz.a1.typesense.net",                        required: true },
    ],
  },
  "apify": {
    package: "@apify/actors-mcp-server",
    description: "Run Apify actors at scale — web scraping, data extraction, automation",
    category: "Search",
    env: [
      { name: "APIFY_TOKEN", hint: "API token from console.apify.com/account/integrations", required: true },
    ],
  },

  "discord": {
    package: "discord-mcp-server",
    description: "Discord messaging — send/read messages, manage channels and servers",
    category: "Communication",
    env: [
      { name: "DISCORD_TOKEN", hint: "Bot token from discord.com/developers/applications > Bot", required: true },
    ],
  },
  "resend": {
    package: "resend-mcp",
    description: "Send emails via Resend — HTML, attachments, scheduling, contacts",
    category: "Communication",
    env: [
      { name: "RESEND_API_KEY", hint: "API key from resend.com/api-keys", required: true },
    ],
  },
  "twilio": {
    package: "@twilio-alpha/mcp",
    description: "Twilio SMS, voice, video, WhatsApp and all Twilio APIs",
    category: "Communication",
    env: [
      { name: "TWILIO_ACCOUNT_SID", hint: "Account SID from twilio.com/console", required: true },
      { name: "TWILIO_AUTH_TOKEN",   hint: "Auth token from twilio.com/console",  required: true },
    ],
  },
  "telegram": {
    package: "telegram-mcp-server",
    description: "Interact with Telegram — read messages, dialogs, user data",
    category: "Communication",
    env: [
      { name: "TELEGRAM_API_ID",   hint: "API ID from my.telegram.org/apps",   required: true },
      { name: "TELEGRAM_API_HASH", hint: "API hash from my.telegram.org/apps", required: true },
    ],
  },
  "mailchimp": {
    package: "@agentx-ai/mailchimp-mcp-server",
    description: "Read-only Mailchimp marketing — campaigns, lists, subscribers, analytics",
    category: "Communication",
    env: [
      { name: "MAILCHIMP_API_KEY", hint: "API key from mailchimp.com/account/api/", required: true },
    ],
  },

  "hubspot": {
    package: "@hubspot/mcp-server",
    description: "HubSpot CRM — contacts, deals, tickets, companies and pipelines",
    category: "Productivity",
    env: [
      { name: "HUBSPOT_ACCESS_TOKEN", hint: "Private app token from HubSpot > Settings > Integrations > Private Apps", required: true },
    ],
  },
  "contentful": {
    package: "@contentful/mcp-server",
    description: "Contentful CMS — manage content types, entries, assets and spaces",
    category: "Productivity",
    env: [
      { name: "CONTENTFUL_MANAGEMENT_TOKEN", hint: "CMA token from app.contentful.com/account/profile/cma_tokens", required: true },
      { name: "CONTENTFUL_SPACE_ID",         hint: "Space ID from Settings > General in your space",                  required: true },
    ],
  },
  "sanity": {
    package: "@sanity/mcp-server",
    description: "Sanity CMS — query and mutate documents, manage datasets",
    category: "Productivity",
    env: [
      { name: "SANITY_AUTH_TOKEN", hint: "API token from sanity.io/manage > API > Tokens", required: true },
      { name: "SANITY_PROJECT_ID", hint: "Project ID from sanity.io/manage",                required: true },
    ],
  },
  "clickup": {
    package: "@chykalophia/clickup-mcp-server",
    description: "ClickUp project management — tasks, spaces, lists, 177+ tools",
    category: "Productivity",
    env: [
      { name: "CLICKUP_API_KEY", hint: "API key from app.clickup.com > Settings > Apps", required: true },
    ],
  },
  "trello": {
    package: "@iflow-mcp/trello-mcp-server",
    description: "Trello boards, lists, cards, labels and checklists",
    category: "Productivity",
    env: [
      { name: "TRELLO_API_KEY", hint: "API key from trello.com/power-ups/admin — generate key",      required: true },
      { name: "TRELLO_TOKEN",   hint: "Token generated via the authorize link on the same page", required: true },
    ],
  },
  "confluence": {
    package: "@zereight/mcp-confluence",
    description: "Search and read Confluence pages and spaces via CQL queries",
    category: "Productivity",
    env: [
      { name: "CONFLUENCE_URL",       hint: "Instance URL, e.g. https://yourteam.atlassian.net/wiki",        required: true },
      { name: "CONFLUENCE_USERNAME",  hint: "Atlassian account email",                                        required: true },
      { name: "CONFLUENCE_API_TOKEN", hint: "API token from id.atlassian.com/manage-profile/security/api-tokens", required: true },
    ],
  },
  "jira": {
    package: "jira-mcp",
    description: "Jira issue search (JQL), retrieval and management",
    category: "Productivity",
    env: [
      { name: "JIRA_URL",       hint: "Instance URL, e.g. https://yourteam.atlassian.net",                        required: true },
      { name: "JIRA_USERNAME",  hint: "Atlassian account email",                                                    required: true },
      { name: "JIRA_API_TOKEN", hint: "API token from id.atlassian.com/manage-profile/security/api-tokens", required: true },
    ],
  },
  "todoist": {
    package: "todoist-mcp-server",
    description: "Todoist task management — create, update, complete tasks and projects",
    category: "Productivity",
    env: [
      { name: "TODOIST_API_TOKEN", hint: "API token from app.todoist.com/app/settings/integrations/developer", required: true },
    ],
  },

  "wordpress-mcp": {
    package: "wordpress-mcp",
    description: "WordPress REST API — posts, pages, media, users, plugins",
    category: "CMS",
    env: [
      { name: "WORDPRESS_URL",      hint: "Site URL, e.g. https://example.com",                       required: true },
      { name: "WORDPRESS_USERNAME", hint: "Admin username with REST API access",                       required: true },
      { name: "WORDPRESS_PASSWORD", hint: "Application password from Users > Edit > App Passwords", required: true },
    ],
  },
  "strapi": {
    package: "strapi-mcp",
    description: "Strapi CMS — manage content types and entries via MCP",
    category: "CMS",
    env: [
      { name: "STRAPI_URL",       hint: "Strapi URL, e.g. http://localhost:1337", required: true },
      { name: "STRAPI_API_TOKEN", hint: "Full-access API token from Settings > API Tokens", required: true },
    ],
  },
  "ghost": {
    package: "@ryukimin/ghost-mcp",
    description: "Ghost CMS — manage posts, pages, tags and members",
    category: "CMS",
    env: [
      { name: "GHOST_URL",           hint: "Ghost site URL, e.g. https://myblog.com",               required: true },
      { name: "GHOST_ADMIN_API_KEY", hint: "Admin API key from Ghost Admin > Settings > Integrations", required: true },
    ],
  },

  "google-calendar": {
    package: "@cocal/google-calendar-mcp",
    description: "Google Calendar — events, scheduling, free/busy, multi-calendar",
    category: "Google",
    env: [
      { name: "GOOGLE_OAUTH_CREDENTIALS", hint: "OAuth 2.0 client credentials JSON from Google Cloud Console", required: true },
    ],
  },
  "gmail": {
    package: "@shinzolabs/gmail-mcp",
    description: "Gmail — send, search, read, label, draft, filter and manage emails and threads",
    category: "Google",
    env: [
      { name: "CLIENT_ID", hint: "OAuth 2.0 client ID from Google Cloud Console", required: true },
      { name: "CLIENT_SECRET", hint: "OAuth 2.0 client secret from Google Cloud Console", required: true },
      { name: "REFRESH_TOKEN", hint: "OAuth 2.0 refresh token (run auth flow to obtain)", required: true },
    ],
  },
  "google-sheets": {
    package: "@gpwork4u/google-sheets-mcp",
    description: "Google Sheets — read, write and manage spreadsheet data",
    category: "Google",
    env: [
      { name: "GOOGLE_OAUTH_CREDENTIALS", hint: "OAuth 2.0 client credentials JSON from Google Cloud Console", required: true },
    ],
  },

  "replicate": {
    package: "replicate-mcp",
    description: "Run AI models on Replicate — image generation, audio, video, LLMs",
    category: "AI",
    env: [
      { name: "REPLICATE_API_TOKEN", hint: "API token from replicate.com/account/api-tokens", required: true },
    ],
  },

  "youtube-transcript": {
    package: "@kimtaeyoon83/mcp-server-youtube-transcript",
    description: "Fetch YouTube video transcripts/subtitles by URL or video ID",
    category: "Media",
    env: [],
  },
  "spotify": {
    package: "@tbrgeek/spotify-mcp-server",
    description: "Spotify playback control — play, pause, search, queue, playlists",
    category: "Media",
    env: [
      { name: "SPOTIFY_CLIENT_ID",     hint: "Client ID from developer.spotify.com/dashboard",     required: true },
      { name: "SPOTIFY_CLIENT_SECRET", hint: "Client secret from developer.spotify.com/dashboard", required: true },
    ],
  },

  "salesforce": {
    package: "@advanced-communities/salesforce-mcp-server",
    description: "Salesforce CRM via Salesforce CLI — objects, queries, metadata",
    category: "Sales",
    env: [
      { name: "SF_USERNAME",   hint: "Salesforce username (email)",                            required: true },
      { name: "SF_INSTANCE_URL", hint: "Instance URL, e.g. https://myorg.my.salesforce.com", required: true },
    ],
  },
};
const FAST_KEYWORDS  = new Set(["show","list","get","fetch","find","check","count","display","status","health","ping","version","info","which","who","what is","what are","how many","is there","are there"]);
const SMART_KEYWORDS = new Set(["analyze","analyse","audit","debug","diagnose","investigate","optimize","optimise","review","evaluate","compare","migrate","migration","restructure","refactor","comprehensive","thorough","complete","detailed","full report","performance","security","vulnerability","why is","why does","figure out","root cause","step by step"]);

function autoSelectModel(message: string): [string, string] {
  const msg   = message.toLowerCase().trim();
  const words = msg.split(/\s+/);
  const n     = words.length;

  if (n > 80)                                       return [SMART_MODEL, "smart"];
  if ((msg.match(/ and /g) ?? []).length >= 3)      return [SMART_MODEL, "smart"];
  if ([...SMART_KEYWORDS].some(kw => msg.includes(kw))) return [SMART_MODEL, "smart"];
  if (n <= 15 && [...FAST_KEYWORDS].some(kw => msg.includes(kw))) return [FAST_MODEL, "fast"];
  if (n <= 5)                                        return [FAST_MODEL, "fast"];
  return [DEFAULT_MODEL, "standard"];
}
function clearFlows(ctx: MyContext): void {
  delete ctx.session.skillDraft;
  delete ctx.session.skillStep;
  delete ctx.session.pendingSkillDelete;
  delete ctx.session.mcpDraft;
  delete ctx.session.mcpStep;
}

function inFlow(ctx: MyContext): boolean {
  return !!(ctx.session.skillStep || ctx.session.pendingSkillDelete || ctx.session.mcpStep);
}
function isAdmin(ctx: MyContext): boolean {
  return ADMIN_USER_IDS.has(ctx.from?.id ?? 0);
}
const agentAxios = axios.create({ proxy: false });
const bot = new Bot<MyContext>(TELEGRAM_BOT_TOKEN, {
  client: HTTPS_PROXY
    ? { baseFetchConfig: { agent: new HttpsProxyAgent(HTTPS_PROXY) } }
    : {},
});

bot.use(session({ initial: (): SessionData => ({}) }));
bot.command("start", async ctx => {
  if (!isAdmin(ctx)) { await ctx.reply("⛔ Unauthorized."); return; }
  await ctx.reply(
    "👋 *WordPress Agent* is ready\\.\n\n" +
    "Send a task in plain English:\n" +
    "• _Create a blog post about Python tips_\n" +
    "• _Install WooCommerce and create 3 products_\n" +
    "• _Show me all active plugins_\n" +
    "• _Publish the draft post at 5pm UTC_\n" +
    "• _Update all plugins every Monday at 3am_\n\n" +
    "🎙️ *Voice messages* are supported — just send a voice note\\!\n\n" +
    "Commands:\n" +
    "`/status`  — check agent health\n" +
    "`/model`   — show or change AI model\n" +
    "`/tasks`   — list or cancel scheduled tasks\n" +
    "`/skill`   — manage custom skills\n" +
    "`/mcp`     — manage MCP tool servers\n" +
    "`/cancel`  — cancel current task & clear history",
    { parse_mode: "MarkdownV2" },
  );
});
bot.command("status", async ctx => {
  if (!isAdmin(ctx)) return;
  try {
    const r = await agentAxios.get(`${AGENT_URL}/health`, { timeout: 5000 });
    const d = r.data;
    const routingMode = AUTO_ROUTING ? "auto (smart routing on)" : "manual";
    await ctx.reply(
      `✅ Agent online\n` +
      `Default model: \`${d.model ?? "unknown"}\`\n` +
      `Model routing: \`${routingMode}\`\n` +
      `Scheduler: \`${d.scheduler ?? "unknown"}\` (${d.scheduled_jobs ?? 0} job(s))\n` +
      `Custom skills: \`${d.custom_skills ?? 0}\`\n` +
      `MCP tools: \`${d.mcp_tools ?? 0}\`\n` +
      `Voice (Whisper): \`${d.whisper ?? "unknown"}\``,
      { parse_mode: "Markdown" },
    );
  } catch (e) {
    await ctx.reply(`❌ Agent unreachable: ${sanitize(String(e))}`);
  }
});
bot.command("model", async ctx => {
  if (!isAdmin(ctx)) return;
  const args   = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const manual = ctx.session.model;

  if (!args.length) {
    let currentLine: string;
    if (AUTO_ROUTING && !manual) {
      currentLine =
        `Current: *auto\\-routing* 🧠\n` +
        `  Fast  → \`${FAST_MODEL}\`\n` +
        `  Standard → \`${DEFAULT_MODEL}\`\n` +
        `  Smart → \`${SMART_MODEL}\`\n\n` +
        "Use `/model auto` to keep routing on, or pick a model to lock it in\\.";
    } else {
      currentLine = `Current model: \`${manual ?? DEFAULT_MODEL}\``;
      if (AUTO_ROUTING) currentLine += " _\\(auto\\-routing overridden\\)_\nUse `/model auto` to re\\-enable routing\\.";
    }
    await ctx.reply(
      `${currentLine}\n\n` +
      "*Select a model:*\n" +
      "• `auto` — smart routing ⚡/◆/🧠\n\n" +
      "*Anthropic:*\n" +
      "• `claude-sonnet-4-6` — default, best quality\n" +
      "• `claude-haiku-4-5` — fast & cheap\n" +
      "• `claude-opus-4-6` — hardest tasks\n\n" +
      "*OpenAI:*\n" +
      "• `gpt-4o` / `gpt-4o-mini`\n\n" +
      "*DeepSeek:*\n" +
      "• `deepseek-chat` / `deepseek-reasoner`\n\n" +
      "*Google:*\n" +
      "• `gemini-2.0-flash`\n\n" +
      "*Via OpenRouter* \\(only OPENROUTER\\_API\\_KEY needed\\):\n" +
      "• `openrouter/claude-sonnet-4-6` / `openrouter/claude-opus-4-6` / `openrouter/claude-haiku-4-5`\n" +
      "• `openrouter/gpt-4o` / `openrouter/gpt-4o-mini`\n" +
      "• `openrouter/gemini-2.0-flash`\n" +
      "• `openrouter/deepseek-chat` / `openrouter/deepseek-r1`\n" +
      "• `openrouter/llama-3.3-70b` · `openrouter/mistral-large` · `openrouter/qwq-32b`\n" +
      "• Any slug from openrouter\\.ai — prefix with `openrouter/`\n\n" +
      "Usage: `/model claude-opus-4-6` — lock to a model\n" +
      "Usage: `/model auto` — enable smart routing",
      { parse_mode: "MarkdownV2" },
    );
    return;
  }

  const choice = args[0].trim();
  if (choice === "auto") {
    delete ctx.session.model;
    const status = AUTO_ROUTING
      ? "✅ Auto-routing re-enabled."
      : "ℹ️ Auto-routing is disabled in .env (AUTO_ROUTING=false). The default model will be used.";
    await ctx.reply(status);
  } else if (!isValidModel(choice)) {
    await ctx.reply(
      `❌ Unknown model: \`${choice}\`\n\nUse \`/model\` to see the list of available models.\nFor OpenRouter, prefix with \`openrouter/\` — e.g. \`openrouter/llama-3.3-70b\``,
      { parse_mode: "Markdown" },
    );
  } else {
    ctx.session.model = choice;
    await ctx.reply(`✅ Locked to model: \`${choice}\``, { parse_mode: "Markdown" });
  }
});
bot.command("cancel", async ctx => {
  if (!isAdmin(ctx)) return;
  const wasInFlow = inFlow(ctx);
  clearFlows(ctx);
  delete ctx.session.history;
  await ctx.reply(wasInFlow
    ? "🛑 Flow cancelled and conversation history cleared."
    : "🛑 Task cancelled and conversation history cleared.");
});
bot.command("tasks", async ctx => {
  if (!isAdmin(ctx)) return;
  const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);

  if (args[0]?.toLowerCase() === "cancel") {
    if (!args[1]) { await ctx.reply("Usage: `/tasks cancel <job_id>`", { parse_mode: "Markdown" }); return; }
    try {
      const r = await agentAxios.delete(`${AGENT_URL}/schedules/${args[1]}`, { timeout: 10000 });
      if (r.data.error) {
        await ctx.reply(`❌ ${r.data.error}`);
      } else {
        await ctx.reply(`✅ Scheduled task \`${args[1]}\` cancelled.`, { parse_mode: "Markdown" });
      }
    } catch (e) { await ctx.reply(`❌ Error: ${e}`); }
    return;
  }

  try {
    const r    = await agentAxios.get(`${AGENT_URL}/schedules`, { timeout: 10000 });
    const jobs = r.data.jobs ?? [];
    if (!jobs.length) {
      await ctx.reply(
        "📅 No scheduled tasks.\n\nSchedule one by telling the bot:\n_\"Update all plugins every Monday at 3am UTC\"_",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const lines = ["📅 *Scheduled Tasks:*\n"];
    for (const job of jobs) {
      lines.push(`*${job.name}*`);
      lines.push(`  Next run: \`${job.next_run}\``);
      lines.push(`  Trigger: \`${job.trigger}\``);
      lines.push(`  ID: \`${job.id}\``);
      lines.push("");
    }
    lines.push("To cancel: `/tasks cancel <ID>`");
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (e) { await ctx.reply(`❌ Error fetching schedules: ${e}`); }
});
bot.command("skill", async ctx => {
  if (!isAdmin(ctx)) return;
  const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const sub  = (args[0] ?? "").toLowerCase();

  if (sub === "reload") {
    try {
      const r    = await agentAxios.post(`${AGENT_URL}/reload-skills`, {}, { timeout: 15000 });
      const names = (r.data.skills ?? []).map((n: string) => `• \`${n}\``).join("\n") || "_(none)_";
      await ctx.reply(`🔄 Skills reloaded — ${r.data.loaded ?? 0} custom skill(s) active:\n\n${names}`, { parse_mode: "Markdown" });
    } catch (e) { await ctx.reply(`❌ Reload failed: ${e}`); }
    return;
  }

  if (sub === "show") {
    if (!args[1]) { await ctx.reply("Usage: `/skill show <name>`", { parse_mode: "Markdown" }); return; }
    try {
      const r = await agentAxios.get(`${AGENT_URL}/skills/${args[1]}`, { timeout: 10000 });
      if (r.status === 404) { await ctx.reply(`❌ Skill \`${args[1]}\` not found.`, { parse_mode: "Markdown" }); return; }
      await ctx.reply(`📄 *Skill:* \`${args[1]}\`\n\n\`\`\`\n${r.data.yaml}\n\`\`\``, { parse_mode: "Markdown" });
    } catch (e) { await ctx.reply(`❌ Error: ${e}`); }
    return;
  }

  if (sub === "delete") {
    if (!args[1]) { await ctx.reply("Usage: `/skill delete <name>`", { parse_mode: "Markdown" }); return; }
    ctx.session.pendingSkillDelete = args[1];
    await ctx.reply(
      `⚠️ Are you sure you want to delete skill \`${args[1]}\`?\n\nType \`yes\` to confirm or \`/cancel\` to abort.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (sub === "create") {
    clearFlows(ctx);
    ctx.session.skillDraft = {};
    ctx.session.skillStep  = "name";
    await ctx.reply(
      "🛠️ *Create a new skill* — Step 1/5\n\n" +
      "What is the skill *name*?\n_(alphanumeric + underscores only, e.g. `check_ssl`)_\n\nType `/cancel` at any time to abort.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Default: list
  try {
    const r       = await agentAxios.get(`${AGENT_URL}/skills`, { timeout: 10000 });
    const builtin = (r.data.builtin ?? []).map((n: string) => `• \`${n}\``).join("\n");
    const custom  = (r.data.custom  ?? []).map((n: string) => `• \`${n}\``).join("\n") || "_(none)_";
    await ctx.reply(
      `🔌 *Custom Skills:*\n${custom}\n\n⚙️ *Built-in Tools:*\n${builtin}\n\n` +
      "Sub-commands:\n• `/skill create` — guided skill creation\n• `/skill show <name>` — view skill YAML\n• `/skill delete <name>` — remove a skill\n• `/skill reload` — reload from disk",
      { parse_mode: "Markdown" },
    );
  } catch (e) { await ctx.reply(`❌ Error fetching skills: ${e}`); }
});
async function handleSkillCreateStep(ctx: MyContext): Promise<boolean> {
  const step  = ctx.session.skillStep;
  const draft = ctx.session.skillDraft ?? {};
  const text  = ctx.message?.text?.trim() ?? "";
  if (!step) return false;

  if (step === "name") {
    if (!/^[a-zA-Z0-9_]+$/.test(text)) {
      await ctx.reply("❌ Invalid name. Use only letters, numbers, and underscores.\n\nTry again:");
      return true;
    }
    draft.name = text;
    ctx.session.skillDraft = draft;
    ctx.session.skillStep  = "type";
    await ctx.reply(
      `🛠️ *Create a new skill* — Step 2/5\n\nName: \`${text}\`\n\nWhat *type* of skill?\n• \`command\` — runs a shell command on the server\n• \`http\` — calls an external HTTP API\n• \`webhook\` — sends a POST to a URL`,
      { parse_mode: "Markdown" },
    );
    return true;
  }

  if (step === "type") {
    if (!["command", "http", "webhook"].includes(text.toLowerCase())) {
      await ctx.reply("❌ Please reply with: `command`, `http`, or `webhook`", { parse_mode: "Markdown" });
      return true;
    }
    draft.type = text.toLowerCase();
    ctx.session.skillDraft = draft;
    ctx.session.skillStep  = "cmd_or_url";
    const prompt = draft.type === "command"
      ? "Enter the *shell command* to run.\nUse `{param_name}` for parameters, e.g.:\n`df -h {path}`"
      : "Enter the *URL* for the API endpoint.\nUse `{param_name}` for URL path variables, e.g.:\n`https://api.example.com/check/{domain}`";
    await ctx.reply(`🛠️ *Create a new skill* — Step 3/5\n\n${prompt}`, { parse_mode: "Markdown" });
    return true;
  }

  if (step === "cmd_or_url") {
    if (draft.type === "command") draft.command = text;
    else                          draft.url     = text;
    ctx.session.skillDraft = draft;
    ctx.session.skillStep  = "description";
    await ctx.reply(
      "🛠️ *Create a new skill* — Step 4/5\n\nEnter a *description* the AI will use to decide when to call this skill.\nBe specific! Or type `skip` for a default description.",
      { parse_mode: "Markdown" },
    );
    return true;
  }

  if (step === "description") {
    if (text.toLowerCase() !== "skip") draft.description = text;
    ctx.session.skillDraft = draft;
    ctx.session.skillStep  = "params";
    await ctx.reply(
      "🛠️ *Create a new skill* — Step 5/5\n\nAdd *parameters*? Enter one per line:\n`name|description|type|required`\n\nExample:\n`query|The search query|string|true`\n`limit|Max results|integer|false`\n\nOr type `none` for no parameters.",
      { parse_mode: "Markdown" },
    );
    return true;
  }

  if (step === "params") {
    const params: any[] = [];
    if (text.toLowerCase() !== "none") {
      for (const line of text.split("\n")) {
        const parts = line.split("|").map(p => p.trim());
        if (parts.length >= 2) {
          params.push({
            name:        parts[0],
            description: parts[1] ?? "",
            type:        parts[2] ?? "string",
            required:    (parts[3] ?? "false").toLowerCase() === "true",
          });
        }
      }
    }
    draft.parameters       = params;
    ctx.session.skillDraft = draft;
    ctx.session.skillStep  = "confirm";
    const preview = (yaml.dump(draft, { noRefs: true }) as string).trim();
    await ctx.reply(
      `🛠️ *Preview your skill:*\n\n\`\`\`\n${preview}\n\`\`\`\n\nType \`save\` to create it, or \`/cancel\` to abort.`,
      { parse_mode: "Markdown" },
    );
    return true;
  }

  if (step === "confirm") {
    if (text.toLowerCase() !== "save") {
      await ctx.reply("Type `save` to confirm, or `/cancel` to abort.", { parse_mode: "Markdown" });
      return true;
    }
    const rawYaml = yaml.dump(draft, { noRefs: true }) as string;
    try {
      const r = await agentAxios.post(`${AGENT_URL}/skills`, { yaml: rawYaml }, { timeout: 15000 });
      if (r.data.error) {
        await ctx.reply(`❌ Failed to create skill:\n${r.data.error}`);
      } else {
        const name = r.data.name ?? draft.name ?? "?";
        clearFlows(ctx);
        await ctx.reply(`✅ Skill \`${name}\` created! The agent can now use it immediately.`, { parse_mode: "Markdown" });
      }
    } catch (e) { await ctx.reply(`❌ Error saving skill: ${e}`); }
    return true;
  }

  return false;
}
async function handleSkillDeleteConfirm(ctx: MyContext): Promise<boolean> {
  const pending = ctx.session.pendingSkillDelete;
  if (!pending) return false;

  const text = (ctx.message?.text ?? "").trim().toLowerCase();
  if (text === "yes") {
    try {
      const r = await agentAxios.delete(`${AGENT_URL}/skills/${pending}`, { timeout: 10000 });
      delete ctx.session.pendingSkillDelete;
      if (r.data.error) {
        await ctx.reply(`❌ ${r.data.error}`);
      } else {
        await ctx.reply(`✅ Skill \`${pending}\` deleted.`, { parse_mode: "Markdown" });
      }
    } catch (e) { await ctx.reply(`❌ Error: ${e}`); }
  } else {
    await ctx.reply(
      `Type \`yes\` to confirm deletion of \`${pending}\`, or \`/cancel\` to abort.`,
      { parse_mode: "Markdown" },
    );
  }
  return true;
}
bot.command("mcp", async ctx => {
  if (!isAdmin(ctx)) return;
  const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const sub  = (args[0] ?? "").toLowerCase();

  if (sub === "reload") {
    try {
      const r     = await agentAxios.post(`${AGENT_URL}/reload-mcps`, {}, { timeout: 15000 });
      const tools = (r.data.tools ?? []).map((t: string) => `• \`${t}\``).join("\n") || "_(none)_";
      await ctx.reply(`🔄 MCP tools reloaded — ${r.data.loaded ?? 0} tool(s) active:\n\n${tools}`, { parse_mode: "Markdown" });
    } catch (e) { await ctx.reply(`❌ Reload failed: ${e}`); }
    return;
  }

  if (sub === "tools") {
    if (!args[1]) { await ctx.reply("Usage: `/mcp tools <name>`", { parse_mode: "Markdown" }); return; }
    try {
      const r = await agentAxios.get(`${AGENT_URL}/mcps/${args[1]}/tools`, { timeout: 10000 });
      if (r.status === 404) { await ctx.reply(`❌ MCP \`${args[1]}\` not found.`, { parse_mode: "Markdown" }); return; }
      const tools = r.data.tools ?? [];
      if (!tools.length) { await ctx.reply(`MCP \`${args[1]}\` has no tools.`, { parse_mode: "Markdown" }); return; }
      const lines = [`🔧 *Tools in \`${args[1]}\`:*\n`];
      for (const t of tools) lines.push(`• \`${t.name}\` — ${(t.description ?? "").slice(0, 80)}`);
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } catch (e) { await ctx.reply(`❌ Error: ${e}`); }
    return;
  }

  if (sub === "remove") {
    if (!args[1]) { await ctx.reply("Usage: `/mcp remove <name>`", { parse_mode: "Markdown" }); return; }
    try {
      const r = await agentAxios.delete(`${AGENT_URL}/mcps/${args[1]}`, { timeout: 15000 });
      if (r.data.error) {
        await ctx.reply(`❌ ${r.data.error}`);
      } else {
        await ctx.reply(`✅ MCP \`${args[1]}\` removed. Use \`/mcp reload\` to update the agent's tool list.`, { parse_mode: "Markdown" });
      }
    } catch (e) { await ctx.reply(`❌ Error: ${e}`); }
    return;
  }

  if (sub === "available") {
    const CATEGORY_EMOJI: Record<string, string> = {
      Utility: "🔧", Database: "🗄", Search: "🔍", Developer: "⚙",
      Productivity: "📋", Communication: "💬", Payments: "💳",
      Browser: "🌐", Cloud: "☁", CMS: "📝", Google: "📊",
      AI: "🤖", Media: "🎬", Sales: "📈",
    };
    const cats: Record<string, Array<[string, McpEntry]>> = {};
    for (const [slug, info] of Object.entries(MCP_CATALOG)) {
      if (!cats[info.category]) cats[info.category] = [];
      cats[info.category].push([slug, info]);
    }
    const total = Object.keys(MCP_CATALOG).length;
    const lines = [`📦 *Available MCPs* (${total})\nInstall: \`/mcp install <name>\`\n`];
    for (const [cat, entries] of Object.entries(cats)) {
      const emoji = CATEGORY_EMOJI[cat] ?? "📦";
      lines.push(`*${emoji} ${cat}*`);
      for (const [slug, info] of entries) {
        const reqVars = info.env.filter(e => e.required);
        let line = `• \`${slug}\` — ${info.description}`;
        if (reqVars.length) {
          line += ` [${reqVars.map(e => e.name).join(", ")}]`;
        }
        lines.push(line);
      }
      lines.push("");
    }
    lines.push("Use `/mcp info <name>` for setup details");

    const chunks: string[] = [];
    let current = "";
    for (const line of lines) {
      if (current.length + line.length + 1 > 4000) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? "\n" : "") + line;
      }
    }
    if (current) chunks.push(current);
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    }
    return;
  }

  if (sub === "info") {
    if (!args[1]) { await ctx.reply("Usage: `/mcp info <name>`", { parse_mode: "Markdown" }); return; }
    const slug = args[1].toLowerCase();
    const info = MCP_CATALOG[slug];
    if (!info) { await ctx.reply(`❌ \`${slug}\` not in catalog. Use \`/mcp available\` to browse.`, { parse_mode: "Markdown" }); return; }
    const lines = [`📦 *${slug}*`, `\`${info.package}\``, `_${info.description}_\n`];
    if (info.env.length) {
      lines.push("*Required environment variables:*");
      for (const e of info.env) {
        lines.push(`• \`${e.name}\` _(${e.required ? "required" : "optional"})_`);
        lines.push(`  ${e.hint}`);
      }
    } else {
      lines.push("✅ No API keys required.");
    }
    lines.push(`\nInstall: \`/mcp install ${slug}\``);
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    return;
  }

  if (sub === "install") {
    if (!args[1]) {
      await ctx.reply("Usage: `/mcp install <name>`\n\nBrowse available MCPs with `/mcp available`", { parse_mode: "Markdown" });
      return;
    }
    const shortName = args[1].toLowerCase();
    if (!MCP_CATALOG[shortName]) {
      await ctx.reply(`❌ \`${shortName}\` is not in the catalog.\n\nUse \`/mcp available\` to see all options.`, { parse_mode: "Markdown" });
      return;
    }
    const info = MCP_CATALOG[shortName];
    clearFlows(ctx);
    ctx.session.mcpDraft = { short_name: shortName, package: info.package, env: {}, env_defs: info.env };

    const requiredVars = info.env.filter(e => e.required);
    if (requiredVars.length) {
      const lines = [`📦 *${shortName}* — ${info.description}\n`, "*This MCP needs the following environment variables:*\n"];
      for (const e of info.env) {
        lines.push(`• \`${e.name}\` _(${e.required ? "required" : "optional"})_`);
        lines.push(`  _${e.hint}_\n`);
      }
      lines.push("Do you have these credentials? Reply `yes` to enter them, `no` to cancel, or `skip` to install without them (it may not work).");
      ctx.session.mcpStep = "env_choice";
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } else {
      ctx.session.mcpStep = "installing";
      await doMcpInstall(ctx);
    }
    return;
  }

  // Default: list installed MCPs
  try {
    const r    = await agentAxios.get(`${AGENT_URL}/mcps`, { timeout: 10000 });
    const mcps = r.data.mcps ?? [];
    if (!mcps.length) {
      await ctx.reply(
        "🔧 *No MCPs installed.*\n\n• `/mcp available` — browse all available MCPs\n• `/mcp install <name>` — install one\n• `/mcp info <name>` — see env vars and setup details",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const lines = ["🔧 *Installed MCPs:*\n"];
    for (const mcp of mcps) lines.push(`• \`${mcp.name}\` — ${(mcp.tools ?? []).length} tool(s)`);
    lines.push("\n*Commands:*");
    lines.push("• `/mcp available` — browse catalog");
    lines.push("• `/mcp info <name>` — setup details + env vars");
    lines.push("• `/mcp install <name>` — install");
    lines.push("• `/mcp tools <name>` — list tools");
    lines.push("• `/mcp remove <name>` — uninstall");
    lines.push("• `/mcp reload` — sync tools to agent");
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (e) { await ctx.reply(`❌ Error fetching MCPs: ${e}`); }
});
async function handleMcpInstallStep(ctx: MyContext): Promise<boolean> {
  const step  = ctx.session.mcpStep;
  const draft = ctx.session.mcpDraft ?? {};
  const text  = (ctx.message?.text ?? "").trim();
  if (!step) return false;

  if (step === "env_choice") {
    const choice = text.toLowerCase();
    if (choice === "yes") {
      ctx.session.mcpStep = "env_vars";
      const envDefs = (draft.env_defs ?? []) as EnvDef[];
      const lines   = ["Enter environment variables, one per line as `KEY=VALUE`\n"];
      for (const e of envDefs) lines.push(`• \`${e.name}\` _(${e.required ? "required" : "optional"})_ — ${e.hint}`);
      lines.push("\nType `done` when finished.");
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } else if (choice === "no" || choice === "skip") {
      ctx.session.mcpStep = "installing";
      await doMcpInstall(ctx);
    } else {
      await ctx.reply("Please reply `yes`, `no`, or `skip`.", { parse_mode: "Markdown" });
    }
    return true;
  }

  if (step === "env_vars") {
    if (text.toLowerCase() === "done") {
      const env      = (draft.env ?? {}) as Record<string, string>;
      const envDefs  = (draft.env_defs ?? []) as EnvDef[];
      const missing  = envDefs.filter(e => e.required && !env[e.name]).map(e => e.name);
      if (missing.length && !draft._missing_warned) {
        await ctx.reply(
          `⚠️ Still missing required variables: ${missing.map(m => `\`${m}\``).join(", ")}\nAdd them or type \`done\` again to install anyway.`,
          { parse_mode: "Markdown" },
        );
        draft._missing_warned = true;
        ctx.session.mcpDraft  = draft;
      } else {
        ctx.session.mcpStep = "installing";
        await doMcpInstall(ctx);
      }
    } else {
      const env = (draft.env ?? {}) as Record<string, string>;
      for (const line of text.split("\n")) {
        if (line.includes("=")) {
          const idx = line.indexOf("=");
          env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
      draft.env            = env;
      draft._missing_warned = false;
      ctx.session.mcpDraft = draft;

      const envDefs = (draft.env_defs ?? []) as EnvDef[];
      const missing = envDefs.filter(e => e.required && !env[e.name]).map(e => e.name);
      const saved   = Object.keys(env).map(k => `\`${k}\``).join(", ");
      if (missing.length) {
        await ctx.reply(
          `✅ Saved: ${saved}\nStill needed: ${missing.map(m => `\`${m}\``).join(", ")}\nType \`done\` when finished.`,
          { parse_mode: "Markdown" },
        );
      } else {
        await ctx.reply(`✅ All variables set: ${saved}\nType \`done\` to install.`, { parse_mode: "Markdown" });
      }
    }
    return true;
  }

  return false;
}

async function doMcpInstall(ctx: MyContext): Promise<void> {
  const draft     = ctx.session.mcpDraft ?? {};
  const pkg       = (draft.package   ?? "") as string;
  const shortName = (draft.short_name ?? "") as string;
  const env       = (draft.env       ?? {}) as Record<string, string>;

  const statusMsg = await ctx.reply(`⏳ Installing \`${pkg}\`… this may take a minute.`, { parse_mode: "Markdown" });
  try {
    const r = await agentAxios.post(
      `${AGENT_URL}/mcps/install`,
      { package: pkg, name: shortName, env },
      { timeout: 120_000 },
    );
    clearFlows(ctx);
    if (r.data.error) {
      await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ Install failed:\n${r.data.error}`);
      return;
    }
    const tools     = r.data.tools ?? [];
    const toolsText = tools.length
      ? tools.map((t: any) => `• \`${t.name}\` — ${(t.description ?? "").slice(0, 60)}`).join("\n")
      : "_(none discovered)_";
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `✅ \`${pkg}\` installed!\n\nTools discovered:\n${toolsText}\n\nUse \`/mcp reload\` to make them available to the agent.`,
      { parse_mode: "Markdown" },
    );
  } catch (e) {
    clearFlows(ctx);
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ Install error: ${sanitize(String(e))}`);
  }
}
async function runAgentTask(ctx: MyContext, taskText: string): Promise<void> {
  const manualModel = ctx.session.model;
  const history     = ctx.session.history ?? [];

  let model: string;
  let modelHint: string;

  if (manualModel) {
    model     = manualModel;
    modelHint = `\`${model}\``;
  } else if (AUTO_ROUTING) {
    const [selectedModel, tier] = autoSelectModel(taskText);
    model     = selectedModel;
    const tierBadge = tier === "fast" ? " · ⚡ fast" : tier === "smart" ? " · 🧠 smart" : "";
    modelHint = `\`${model}\`${tierBadge}`;
  } else {
    model     = DEFAULT_MODEL;
    modelHint = `\`${model}\``;
  }

  const statusMsg = await ctx.reply(`🤔 Thinking… (${modelHint})`, { parse_mode: "Markdown" });

  let result    = "(no result)";
  let elapsed   = 0;
  let modelUsed = model;
  const steps: string[] = [];

  function buildStatus(): string {
    const lines = ["🤔 Thinking…"];
    if (steps.length) { lines.push(""); steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`)); }
    return lines.join("\n");
  }

  try {
    const response = await agentAxios.post(
      `${AGENT_URL}/task`,
      { message: taskText, model, history },
      { responseType: "stream", timeout: 310_000 },
    );

    let buffer = "";
    await new Promise<void>((resolve) => {
      response.data.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const etype = event.type;
            if (etype === "progress") {
              steps.push(event.text ?? "⚙️ Working…");
              ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, buildStatus()).catch(() => {});
            } else if (etype === "thinking") {
              ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, buildStatus()).catch(() => {});
            } else if (etype === "result") {
              result    = event.text ?? "(no result)";
              elapsed   = event.elapsed ?? 0;
              modelUsed = event.model ?? model;
            }
          } catch {}
        }
      });
      response.data.on("end",   resolve);
      response.data.on("error", resolve);
    });
  } catch (e: any) {
    if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
      result = "⏱️ Timed out after 5 minutes.";
    } else if (e.code === "ECONNREFUSED") {
      result = "❌ Agent is unreachable.";
    } else {
      result = `❌ Error: ${sanitize(e.message ?? String(e))}`;
    }
  }

  // Update history (capped at 10 turns = 20 messages)
  const newHistory = [...(ctx.session.history ?? []),
    { role: "user", content: taskText },
    { role: "assistant", content: result },
  ];
  ctx.session.history = newHistory.slice(-20);

  // Delete the "Thinking…" status message
  try { await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id); } catch {}

  // Send result in chunks (Telegram limit: 4096 chars)
  const MAX_LEN = 4000;
  const footer  = `\n\n_⏱ ${elapsed}s • ${modelUsed}_`;
  const chunks  = [];
  for (let i = 0; i < Math.max(result.length, 1); i += MAX_LEN) chunks.push(result.slice(i, i + MAX_LEN));

  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i] + (i === chunks.length - 1 ? footer : "");
    try {
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch {
      try { await ctx.reply(text); } catch (e2) { console.error(`Failed to send chunk: ${e2}`); }
    }
  }
}
bot.on("message:text", async ctx => {
  if (!isAdmin(ctx)) { await ctx.reply("⛔ Unauthorized."); return; }

  // Route to active multi-step flows first
  if (await handleSkillDeleteConfirm(ctx)) return;
  if (await handleSkillCreateStep(ctx))    return;
  if (await handleMcpInstallStep(ctx))     return;

  const userText = (ctx.message.text ?? "").trim();
  if (!userText) return;

  await ctx.replyWithChatAction("typing");
  await runAgentTask(ctx, userText);
});
bot.on("message:voice", async ctx => {
  if (!isAdmin(ctx)) { await ctx.reply("⛔ Unauthorized."); return; }

  const voice     = ctx.message.voice;
  const statusMsg = await ctx.reply("🎙️ Transcribing voice message…");

  let audioBytes: Buffer;
  try {
    const tgFile = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${tgFile.file_path}`;
    const resp = await axios.get(fileUrl, { responseType: "arraybuffer", proxy: false,
      httpsAgent: HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined });
    audioBytes = Buffer.from(resp.data);
  } catch (e) {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ Failed to download voice message: ${sanitize(String(e))}`);
    return;
  }

  let transcribeData: any;
  try {
    const form = new FormData();
    form.append("file", audioBytes, { filename: "voice.ogg", contentType: "audio/ogg" });
    const r = await agentAxios.post(`${AGENT_URL}/transcribe`, form, {
      headers: form.getHeaders(),
      timeout: 60_000,
    });
    transcribeData = r.data;
  } catch (e) {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ Transcription request failed: ${sanitize(String(e))}`);
    return;
  }

  if (transcribeData.error) {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ ${transcribeData.error}`);
    return;
  }

  const transcript = (transcribeData.text ?? "").trim();
  if (!transcript) {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, "❌ Could not transcribe audio (empty result).");
    return;
  }

  await ctx.api.editMessageText(
    statusMsg.chat.id,
    statusMsg.message_id,
    `🎙️ *Heard:* _${transcript}_`,
    { parse_mode: "Markdown" },
  );
  await ctx.replyWithChatAction("typing");
  await runAgentTask(ctx, transcript);
});
bot.on("message:photo", async ctx => {
  if (!isAdmin(ctx)) { await ctx.reply("⛔ Unauthorized."); return; }

  const photo      = ctx.message.photo[ctx.message.photo.length - 1];
  const caption    = (ctx.message.caption ?? "").trim();
  const statusMsg  = await ctx.reply("📤 Uploading to WordPress media library…");

  let photoBytes: Buffer;
  try {
    const tgFile = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${tgFile.file_path}`;
    const resp = await axios.get(fileUrl, { responseType: "arraybuffer", proxy: false,
      httpsAgent: HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined });
    photoBytes = Buffer.from(resp.data);
  } catch (e) {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ Failed to download photo: ${sanitize(String(e))}`);
    return;
  }

  const filename = `telegram_${photo.file_id}.jpg`;
  let uploadData: any;
  try {
    const form = new FormData();
    form.append("file", photoBytes, { filename, contentType: "image/jpeg" });
    const r = await agentAxios.post(`${AGENT_URL}/upload`, form, {
      headers: form.getHeaders(),
      timeout: 60_000,
    });
    uploadData = r.data;
  } catch (e) {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ Upload failed: ${sanitize(String(e))}`);
    return;
  }

  if (uploadData.error) {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ ${uploadData.error}`);
    return;
  }

  const mediaUrl = uploadData.url ?? "";
  const mediaId  = uploadData.id  ?? "";

  if (!caption) {
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `✅ Uploaded to WordPress media library!\n🆔 ID: \`${mediaId}\`\n🔗 ${mediaUrl}`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
  await ctx.replyWithChatAction("typing");
  await runAgentTask(ctx, `A photo was just uploaded to the WordPress media library (ID: ${mediaId}, URL: ${mediaUrl}). ${caption}`);
});
async function main(): Promise<void> {
  // Register bot commands in Telegram's menu
  await bot.api.setMyCommands([
    { command: "start",  description: "Welcome message & feature list" },
    { command: "status", description: "Check agent health" },
    { command: "model",  description: "Show or switch AI model" },
    { command: "cancel", description: "Clear history / cancel active flow" },
    { command: "tasks",  description: "List or cancel scheduled tasks" },
    { command: "skill",  description: "List, create, delete, reload custom skills" },
    { command: "mcp",    description: "Install, list, remove MCP tool servers" },
  ]);

  console.log(`[bot] Starting (admin users: ${[...ADMIN_USER_IDS].join(", ")})`);
  console.log("[bot] Bot commands registered with Telegram.");

  bot.start({
    onStart: () => console.log("[bot] Polling started…"),
  });
}

main().catch(console.error);
