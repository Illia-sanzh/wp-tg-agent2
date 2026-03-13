import { McpEntry } from "./types";

export const MCP_CATALOG: Record<string, McpEntry> = {
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
      {
        name: "POSTGRES_URL",
        hint: "Full connection string, e.g. postgresql://user:pass@host:5432/dbname",
        required: true,
      },
    ],
  },
  "server-sqlite": {
    package: "@modelcontextprotocol/server-sqlite",
    description: "Read/write SQLite databases on the local filesystem",
    category: "Database",
    env: [],
  },
  supabase: {
    package: "@supabase/mcp-server-supabase",
    description: "Manage Supabase projects, databases, storage and edge functions",
    category: "Database",
    env: [
      {
        name: "SUPABASE_ACCESS_TOKEN",
        hint: "Personal access token from app.supabase.com/account/tokens",
        required: true,
      },
    ],
  },
  qdrant: {
    package: "@qdrant/mcp-server-qdrant",
    description: "Store and query vector embeddings for semantic memory",
    category: "Database",
    env: [
      { name: "QDRANT_URL", hint: "Your Qdrant instance URL, e.g. http://localhost:6333 or cloud URL", required: true },
      { name: "QDRANT_API_KEY", hint: "Qdrant Cloud API key (skip for local instances)", required: false },
    ],
  },
  duckdb: {
    package: "@motherduck/mcp-server-duckdb",
    description: "Query DuckDB and MotherDuck cloud warehouse",
    category: "Database",
    env: [
      {
        name: "motherduck_token",
        hint: "MotherDuck token from app.motherduck.com (optional for local DuckDB)",
        required: false,
      },
    ],
  },

  "brave-search": {
    package: "@brave/brave-search-mcp-server",
    description: "Web, news, image and video search via Brave Search API",
    category: "Search",
    env: [{ name: "BRAVE_API_KEY", hint: "API key from brave.com/search/api — free tier available", required: true }],
  },
  tavily: {
    package: "tavily-mcp",
    description: "AI-optimised web search, extract, crawl (great for research)",
    category: "Search",
    env: [
      {
        name: "TAVILY_API_KEY",
        hint: "API key from app.tavily.com — free tier includes 1 000 req/month",
        required: true,
      },
    ],
  },
  exa: {
    package: "exa-mcp-server",
    description: "Neural web search — academic papers, LinkedIn, real-time results",
    category: "Search",
    env: [{ name: "EXA_API_KEY", hint: "API key from exa.ai/api — free trial available", required: true }],
  },
  firecrawl: {
    package: "@mendable/firecrawl-mcp",
    description: "Advanced web scraping, crawling and structured data extraction",
    category: "Search",
    env: [{ name: "FIRECRAWL_API_KEY", hint: "API key from firecrawl.dev — free tier available", required: true }],
  },
  "server-google-maps": {
    package: "@modelcontextprotocol/server-google-maps",
    description: "Geocoding, directions, place search via Google Maps",
    category: "Search",
    env: [
      {
        name: "GOOGLE_MAPS_API_KEY",
        hint: "API key from console.cloud.google.com — enable Maps JavaScript API",
        required: true,
      },
    ],
  },

  "server-github": {
    package: "@modelcontextprotocol/server-github",
    description: "GitHub repos, issues, PRs, file search, code review",
    category: "Developer",
    env: [
      {
        name: "GITHUB_PERSONAL_ACCESS_TOKEN",
        hint: "Classic token from github.com/settings/tokens — needs repo + read:org",
        required: true,
      },
    ],
  },
  cloudflare: {
    package: "@cloudflare/mcp-server-cloudflare",
    description: "Manage Cloudflare Workers, KV, R2, D1, DNS zones",
    category: "Developer",
    env: [
      { name: "CLOUDFLARE_API_TOKEN", hint: "API token from dash.cloudflare.com/profile/api-tokens", required: true },
      {
        name: "CLOUDFLARE_ACCOUNT_ID",
        hint: "Account ID from the right sidebar of your Cloudflare dashboard",
        required: true,
      },
    ],
  },
  sentry: {
    package: "@sentry/mcp-server",
    description: "Query Sentry errors, issues, releases and performance data",
    category: "Developer",
    env: [
      {
        name: "SENTRY_AUTH_TOKEN",
        hint: "Auth token from sentry.io/settings/account/api/auth-tokens/",
        required: true,
      },
      {
        name: "SENTRY_ORG",
        hint: "Your Sentry organisation slug (shown in URL: sentry.io/organizations/<slug>)",
        required: false,
      },
    ],
  },
  vercel: {
    package: "@open-mcp/vercel",
    description: "Manage Vercel deployments, projects, domains and env vars",
    category: "Developer",
    env: [{ name: "VERCEL_API_KEY", hint: "Token from vercel.com/account/tokens", required: true }],
  },

  notion: {
    package: "@notionhq/notion-mcp-server",
    description: "Search, read and write Notion pages and databases",
    category: "Productivity",
    env: [
      {
        name: "NOTION_TOKEN",
        hint: "Integration token from notion.so/profile/integrations — create an internal integration",
        required: true,
      },
    ],
  },
  linear: {
    package: "linear-mcp-server",
    description: "Create and manage Linear issues, projects and cycles",
    category: "Productivity",
    env: [{ name: "LINEAR_API_KEY", hint: "Personal API key from linear.app/settings/api", required: true }],
  },

  "server-slack": {
    package: "@modelcontextprotocol/server-slack",
    description: "Read/write Slack messages, list channels, manage threads",
    category: "Communication",
    env: [
      {
        name: "SLACK_BOT_TOKEN",
        hint: "Bot User OAuth token (xoxb-...) from api.slack.com/apps > OAuth & Permissions",
        required: true,
      },
      {
        name: "SLACK_TEAM_ID",
        hint: "Workspace ID starting with T — shown in workspace URL or admin panel",
        required: true,
      },
    ],
  },

  stripe: {
    package: "@stripe/mcp",
    description: "Query Stripe customers, payments, subscriptions and webhooks",
    category: "Payments",
    env: [
      {
        name: "STRIPE_SECRET_KEY",
        hint: "Secret key from dashboard.stripe.com/apikeys — use test key (sk_test_...) first",
        required: true,
      },
    ],
  },
  shopify: {
    package: "shopify-mcp-server",
    description: "Manage Shopify products, orders, customers and collections",
    category: "Payments",
    env: [
      { name: "SHOPIFY_ACCESS_TOKEN", hint: "Admin API access token from your Shopify app settings", required: true },
      { name: "MYSHOPIFY_DOMAIN", hint: "Your store domain, e.g. mystore.myshopify.com", required: true },
    ],
  },

  "server-puppeteer": {
    package: "@modelcontextprotocol/server-puppeteer",
    description: "Browser automation — navigate, screenshot, click, fill forms",
    category: "Browser",
    env: [],
  },
  playwright: {
    package: "@playwright/mcp",
    description: "Browser automation via Playwright (Microsoft) — headless testing & scraping",
    category: "Browser",
    env: [],
  },
  browserbase: {
    package: "@browserbasehq/mcp-server-browserbase",
    description: "Cloud browser automation with Stagehand — scalable headless browsers",
    category: "Browser",
    env: [
      { name: "BROWSERBASE_API_KEY", hint: "API key from browserbase.com/settings", required: true },
      { name: "BROWSERBASE_PROJECT_ID", hint: "Project ID from your Browserbase dashboard", required: true },
    ],
  },

  "server-redis": {
    package: "@modelcontextprotocol/server-redis",
    description: "Redis key-value store — get, set, list, delete keys",
    category: "Database",
    env: [{ name: "REDIS_URL", hint: "Redis connection URL, e.g. redis://localhost:6379", required: false }],
  },
  mysql: {
    package: "@benborla29/mcp-server-mysql",
    description: "Query and manage MySQL databases with permissions and backup support",
    category: "Database",
    env: [
      { name: "MYSQL_HOST", hint: "Database hostname, e.g. localhost or db.example.com", required: true },
      { name: "MYSQL_USER", hint: "Database username", required: true },
      { name: "MYSQL_PASSWORD", hint: "Database password", required: true },
      { name: "MYSQL_DATABASE", hint: "Default database name", required: true },
    ],
  },
  mongodb: {
    package: "@mongodb-js/mongodb-mcp-server",
    description: "Query and manage MongoDB databases and collections",
    category: "Database",
    env: [
      {
        name: "MONGODB_URI",
        hint: "Connection string, e.g. mongodb+srv://user:pass@cluster.mongodb.net/dbname",
        required: true,
      },
    ],
  },
  neon: {
    package: "@neondatabase/mcp-server-neon",
    description: "Neon serverless Postgres — manage branches, databases, roles",
    category: "Database",
    env: [{ name: "NEON_API_KEY", hint: "API key from console.neon.tech/app/settings/api-keys", required: true }],
  },
  pinecone: {
    package: "@pinecone-database/mcp",
    description: "Pinecone vector database — create indexes, upsert & query embeddings",
    category: "Database",
    env: [{ name: "PINECONE_API_KEY", hint: "API key from app.pinecone.io", required: true }],
  },
  upstash: {
    package: "@upstash/mcp-server",
    description: "Upstash serverless Redis, Kafka & QStash management",
    category: "Database",
    env: [
      { name: "UPSTASH_EMAIL", hint: "Email associated with your Upstash account", required: true },
      { name: "UPSTASH_API_KEY", hint: "Management API key from console.upstash.com/account", required: true },
    ],
  },
  elasticsearch: {
    package: "@elastic/mcp-server-elasticsearch",
    description: "Search, index and manage Elasticsearch clusters",
    category: "Database",
    env: [
      { name: "ES_URL", hint: "Elasticsearch URL, e.g. https://my-cluster.es.cloud:9243", required: true },
      { name: "ES_API_KEY", hint: "API key from Kibana > Stack Management > API Keys", required: true },
    ],
  },
  bigquery: {
    package: "@ergut/mcp-bigquery-server",
    description: "Query and explore Google BigQuery datasets and tables",
    category: "Database",
    env: [
      { name: "GOOGLE_APPLICATION_CREDENTIALS", hint: "Path to service account JSON key file", required: true },
      { name: "BIGQUERY_PROJECT_ID", hint: "Google Cloud project ID", required: true },
    ],
  },
  turso: {
    package: "@prama13/turso-mcp",
    description: "Query Turso / libSQL edge databases (read-only, safe for AI)",
    category: "Database",
    env: [
      { name: "TURSO_DATABASE_URL", hint: "libSQL URL, e.g. libsql://mydb-myorg.turso.io", required: true },
      { name: "TURSO_AUTH_TOKEN", hint: "Auth token from Turso dashboard", required: true },
    ],
  },

  "server-gdrive": {
    package: "@modelcontextprotocol/server-gdrive",
    description: "Read, search and manage Google Drive files and folders",
    category: "Cloud",
    env: [
      {
        name: "GDRIVE_CREDENTIALS",
        hint: "OAuth 2.0 credentials JSON — see Google Cloud Console > APIs > Credentials",
        required: true,
      },
    ],
  },
  "server-aws-kb": {
    package: "@modelcontextprotocol/server-aws-kb-retrieval",
    description: "Query AWS Bedrock knowledge bases for RAG retrieval",
    category: "Cloud",
    env: [
      { name: "AWS_ACCESS_KEY_ID", hint: "IAM access key with Bedrock permissions", required: true },
      { name: "AWS_SECRET_ACCESS_KEY", hint: "IAM secret key", required: true },
      { name: "AWS_REGION", hint: "AWS region, e.g. us-east-1", required: true },
    ],
  },
  azure: {
    package: "@azure/mcp",
    description: "Manage Azure resources — Storage, CosmosDB, App Service, and more",
    category: "Cloud",
    env: [{ name: "AZURE_SUBSCRIPTION_ID", hint: "Subscription ID from Azure Portal", required: true }],
  },
  "aws-s3": {
    package: "aws-s3-mcp",
    description: "Manage AWS S3 buckets and objects — upload, download, list, delete",
    category: "Cloud",
    env: [
      { name: "AWS_ACCESS_KEY_ID", hint: "IAM access key with S3 permissions", required: true },
      { name: "AWS_SECRET_ACCESS_KEY", hint: "IAM secret key", required: true },
      { name: "AWS_REGION", hint: "AWS region, e.g. us-east-1", required: true },
    ],
  },
  dropbox: {
    package: "@microagents/mcp-server-dropbox",
    description: "Access and manage Dropbox files and folders",
    category: "Cloud",
    env: [{ name: "DROPBOX_ACCESS_TOKEN", hint: "Access token from dropbox.com/developers/apps", required: true }],
  },
  box: {
    package: "box-mcp-server",
    description: "Interact with Box cloud content — files, folders, search",
    category: "Cloud",
    env: [
      { name: "BOX_CLIENT_ID", hint: "OAuth client ID from Box Developer Console", required: true },
      { name: "BOX_CLIENT_SECRET", hint: "OAuth client secret from Box Developer Console", required: true },
    ],
  },

  "server-gitlab": {
    package: "@modelcontextprotocol/server-gitlab",
    description: "GitLab repos, merge requests, issues, CI pipelines",
    category: "Developer",
    env: [
      {
        name: "GITLAB_PERSONAL_ACCESS_TOKEN",
        hint: "Token from gitlab.com/-/user_settings/personal_access_tokens",
        required: true,
      },
      { name: "GITLAB_API_URL", hint: "API base URL — default: https://gitlab.com/api/v4 (optional)", required: false },
    ],
  },
  bitbucket: {
    package: "@atlassian-mcp-server/bitbucket",
    description: "Bitbucket repos, pull requests, branches and pipelines",
    category: "Developer",
    env: [
      { name: "BITBUCKET_USERNAME", hint: "Atlassian account username/email", required: true },
      {
        name: "BITBUCKET_APP_PASSWORD",
        hint: "App password from bitbucket.org/account/settings/app-passwords",
        required: true,
      },
    ],
  },
  kubernetes: {
    package: "kubernetes-mcp-server",
    description: "Manage Kubernetes & OpenShift clusters — pods, deployments, services",
    category: "Developer",
    env: [{ name: "KUBECONFIG", hint: "Path to kubeconfig file (optional, uses default if not set)", required: false }],
  },
  terraform: {
    package: "terraform-mcp-server",
    description: "Query Terraform Registry — providers, resources, modules, docs",
    category: "Developer",
    env: [],
  },
  datadog: {
    package: "datadog-mcp-server",
    description: "Search Datadog logs, metrics, dashboards, monitors and events",
    category: "Developer",
    env: [
      { name: "DD_API_KEY", hint: "API key from app.datadoghq.com/organization-settings/api-keys", required: true },
      { name: "DD_APP_KEY", hint: "Application key from the same settings page", required: true },
    ],
  },
  circleci: {
    package: "@circleci/mcp-server-circleci",
    description: "CircleCI build logs, flaky test detection, pipeline insights",
    category: "Developer",
    env: [{ name: "CIRCLECI_TOKEN", hint: "Personal API token from circleci.com/account/api", required: true }],
  },
  openapi: {
    package: "openapi-mcp-server",
    description: "Explore any OpenAPI/Swagger spec — discover endpoints and schemas",
    category: "Developer",
    env: [],
  },
  commands: {
    package: "mcp-server-commands",
    description: "Run shell commands and scripts from the AI agent",
    category: "Developer",
    env: [],
  },
  docker: {
    package: "@0xshariq/docker-mcp-server",
    description: "Docker container, image, volume and network management (16 tools)",
    category: "Developer",
    env: [],
  },

  perplexity: {
    package: "@perplexity-ai/mcp-server",
    description: "Perplexity AI search — real-time web search with reasoning and citations",
    category: "Search",
    env: [{ name: "PERPLEXITY_API_KEY", hint: "API key from perplexity.ai/settings/api", required: true }],
  },
  typesense: {
    package: "typesense-mcp-server",
    description: "Typesense instant search — discover, search and analyse collections",
    category: "Search",
    env: [
      {
        name: "TYPESENSE_API_KEY",
        hint: "API key from your Typesense Cloud cluster or self-hosted instance",
        required: true,
      },
      { name: "TYPESENSE_HOST", hint: "Typesense host, e.g. xyz.a1.typesense.net", required: true },
    ],
  },
  apify: {
    package: "@apify/actors-mcp-server",
    description: "Run Apify actors at scale — web scraping, data extraction, automation",
    category: "Search",
    env: [{ name: "APIFY_TOKEN", hint: "API token from console.apify.com/account/integrations", required: true }],
  },

  discord: {
    package: "discord-mcp-server",
    description: "Discord messaging — send/read messages, manage channels and servers",
    category: "Communication",
    env: [{ name: "DISCORD_TOKEN", hint: "Bot token from discord.com/developers/applications > Bot", required: true }],
  },
  resend: {
    package: "resend-mcp",
    description: "Send emails via Resend — HTML, attachments, scheduling, contacts",
    category: "Communication",
    env: [{ name: "RESEND_API_KEY", hint: "API key from resend.com/api-keys", required: true }],
  },
  twilio: {
    package: "@twilio-alpha/mcp",
    description: "Twilio SMS, voice, video, WhatsApp and all Twilio APIs",
    category: "Communication",
    env: [
      { name: "TWILIO_ACCOUNT_SID", hint: "Account SID from twilio.com/console", required: true },
      { name: "TWILIO_AUTH_TOKEN", hint: "Auth token from twilio.com/console", required: true },
    ],
  },
  telegram: {
    package: "telegram-mcp-server",
    description: "Interact with Telegram — read messages, dialogs, user data",
    category: "Communication",
    env: [
      { name: "TELEGRAM_API_ID", hint: "API ID from my.telegram.org/apps", required: true },
      { name: "TELEGRAM_API_HASH", hint: "API hash from my.telegram.org/apps", required: true },
    ],
  },
  mailchimp: {
    package: "@agentx-ai/mailchimp-mcp-server",
    description: "Read-only Mailchimp marketing — campaigns, lists, subscribers, analytics",
    category: "Communication",
    env: [{ name: "MAILCHIMP_API_KEY", hint: "API key from mailchimp.com/account/api/", required: true }],
  },

  hubspot: {
    package: "@hubspot/mcp-server",
    description: "HubSpot CRM — contacts, deals, tickets, companies and pipelines",
    category: "Productivity",
    env: [
      {
        name: "HUBSPOT_ACCESS_TOKEN",
        hint: "Private app token from HubSpot > Settings > Integrations > Private Apps",
        required: true,
      },
    ],
  },
  contentful: {
    package: "@contentful/mcp-server",
    description: "Contentful CMS — manage content types, entries, assets and spaces",
    category: "Productivity",
    env: [
      {
        name: "CONTENTFUL_MANAGEMENT_TOKEN",
        hint: "CMA token from app.contentful.com/account/profile/cma_tokens",
        required: true,
      },
      { name: "CONTENTFUL_SPACE_ID", hint: "Space ID from Settings > General in your space", required: true },
    ],
  },
  sanity: {
    package: "@sanity/mcp-server",
    description: "Sanity CMS — query and mutate documents, manage datasets",
    category: "Productivity",
    env: [
      { name: "SANITY_AUTH_TOKEN", hint: "API token from sanity.io/manage > API > Tokens", required: true },
      { name: "SANITY_PROJECT_ID", hint: "Project ID from sanity.io/manage", required: true },
    ],
  },
  clickup: {
    package: "@chykalophia/clickup-mcp-server",
    description: "ClickUp project management — tasks, spaces, lists, 177+ tools",
    category: "Productivity",
    env: [{ name: "CLICKUP_API_KEY", hint: "API key from app.clickup.com > Settings > Apps", required: true }],
  },
  trello: {
    package: "@iflow-mcp/trello-mcp-server",
    description: "Trello boards, lists, cards, labels and checklists",
    category: "Productivity",
    env: [
      { name: "TRELLO_API_KEY", hint: "API key from trello.com/power-ups/admin — generate key", required: true },
      { name: "TRELLO_TOKEN", hint: "Token generated via the authorize link on the same page", required: true },
    ],
  },
  confluence: {
    package: "@zereight/mcp-confluence",
    description: "Search and read Confluence pages and spaces via CQL queries",
    category: "Productivity",
    env: [
      { name: "CONFLUENCE_URL", hint: "Instance URL, e.g. https://yourteam.atlassian.net/wiki", required: true },
      { name: "CONFLUENCE_USERNAME", hint: "Atlassian account email", required: true },
      {
        name: "CONFLUENCE_API_TOKEN",
        hint: "API token from id.atlassian.com/manage-profile/security/api-tokens",
        required: true,
      },
    ],
  },
  jira: {
    package: "jira-mcp",
    description: "Jira issue search (JQL), retrieval and management",
    category: "Productivity",
    env: [
      { name: "JIRA_URL", hint: "Instance URL, e.g. https://yourteam.atlassian.net", required: true },
      { name: "JIRA_USERNAME", hint: "Atlassian account email", required: true },
      {
        name: "JIRA_API_TOKEN",
        hint: "API token from id.atlassian.com/manage-profile/security/api-tokens",
        required: true,
      },
    ],
  },
  todoist: {
    package: "todoist-mcp-server",
    description: "Todoist task management — create, update, complete tasks and projects",
    category: "Productivity",
    env: [
      {
        name: "TODOIST_API_TOKEN",
        hint: "API token from app.todoist.com/app/settings/integrations/developer",
        required: true,
      },
    ],
  },

  "wordpress-mcp": {
    package: "wordpress-mcp",
    description: "WordPress REST API — posts, pages, media, users, plugins",
    category: "CMS",
    env: [
      { name: "WORDPRESS_URL", hint: "Site URL, e.g. https://example.com", required: true },
      { name: "WORDPRESS_USERNAME", hint: "Admin username with REST API access", required: true },
      { name: "WORDPRESS_PASSWORD", hint: "Application password from Users > Edit > App Passwords", required: true },
    ],
  },
  strapi: {
    package: "strapi-mcp",
    description: "Strapi CMS — manage content types and entries via MCP",
    category: "CMS",
    env: [
      { name: "STRAPI_URL", hint: "Strapi URL, e.g. http://localhost:1337", required: true },
      { name: "STRAPI_API_TOKEN", hint: "Full-access API token from Settings > API Tokens", required: true },
    ],
  },
  ghost: {
    package: "@ryukimin/ghost-mcp",
    description: "Ghost CMS — manage posts, pages, tags and members",
    category: "CMS",
    env: [
      { name: "GHOST_URL", hint: "Ghost site URL, e.g. https://myblog.com", required: true },
      { name: "GHOST_ADMIN_API_KEY", hint: "Admin API key from Ghost Admin > Settings > Integrations", required: true },
    ],
  },

  "google-calendar": {
    package: "@cocal/google-calendar-mcp",
    description: "Google Calendar — events, scheduling, free/busy, multi-calendar",
    category: "Google",
    env: [
      {
        name: "GOOGLE_OAUTH_CREDENTIALS",
        hint: "OAuth 2.0 client credentials JSON from Google Cloud Console",
        required: true,
      },
    ],
  },
  gmail: {
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
      {
        name: "GOOGLE_OAUTH_CREDENTIALS",
        hint: "OAuth 2.0 client credentials JSON from Google Cloud Console",
        required: true,
      },
    ],
  },

  replicate: {
    package: "replicate-mcp",
    description: "Run AI models on Replicate — image generation, audio, video, LLMs",
    category: "AI",
    env: [{ name: "REPLICATE_API_TOKEN", hint: "API token from replicate.com/account/api-tokens", required: true }],
  },

  "youtube-transcript": {
    package: "@kimtaeyoon83/mcp-server-youtube-transcript",
    description: "Fetch YouTube video transcripts/subtitles by URL or video ID",
    category: "Media",
    env: [],
  },
  spotify: {
    package: "@tbrgeek/spotify-mcp-server",
    description: "Spotify playback control — play, pause, search, queue, playlists",
    category: "Media",
    env: [
      { name: "SPOTIFY_CLIENT_ID", hint: "Client ID from developer.spotify.com/dashboard", required: true },
      { name: "SPOTIFY_CLIENT_SECRET", hint: "Client secret from developer.spotify.com/dashboard", required: true },
    ],
  },

  salesforce: {
    package: "@advanced-communities/salesforce-mcp-server",
    description: "Salesforce CRM via Salesforce CLI — objects, queries, metadata",
    category: "Sales",
    env: [
      { name: "SF_USERNAME", hint: "Salesforce username (email)", required: true },
      { name: "SF_INSTANCE_URL", hint: "Instance URL, e.g. https://myorg.my.salesforce.com", required: true },
    ],
  },
};
