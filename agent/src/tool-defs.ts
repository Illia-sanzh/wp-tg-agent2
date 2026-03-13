import type OpenAI from "openai";

export const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a bash command on the agent server. " +
        "Use this for WP-CLI commands (wp --path=/wordpress --allow-root ...), " +
        "file operations, and server-side tasks. Output is limited to 8000 characters.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute." },
          reason: {
            type: "string",
            description: "One short sentence describing what this step does in plain English, shown to the user.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wp_rest",
      description:
        "Call the WordPress REST API. " +
        "Use for reading/writing posts, pages, media, users, settings, plugins, etc. " +
        "Works for both local and remote WordPress installations.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method." },
          endpoint: { type: "string", description: "REST API endpoint path, e.g. /wp/v2/posts or /wc/v3/products" },
          body: { type: "object", description: "Request body as JSON object (for POST/PUT/PATCH)." },
          params: { type: "object", description: "Query string parameters as key-value pairs." },
          reason: {
            type: "string",
            description: "One short sentence describing what this step does in plain English.",
          },
        },
        required: ["method", "endpoint"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wp_cli_remote",
      description:
        "Run a WP-CLI command on a remote WordPress site via the GreenClaw bridge plugin. " +
        "Use when WordPress is hosted on a different server. " +
        "Provide the WP-CLI command WITHOUT the 'wp' prefix.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "WP-CLI command without the 'wp' prefix. E.g.: 'plugin list --format=json'",
          },
          reason: {
            type: "string",
            description: "One short sentence describing what this step does in plain English.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_task",
      description:
        "Schedule a WordPress management task to run at a specific future time or on a " +
        "recurring schedule. Use this when the user says things like 'at 5pm', " +
        "'every Monday', 'publish tomorrow', 'weekly backup', etc.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Full plain-English description of what to do." },
          run_at: { type: "string", description: "ISO 8601 UTC datetime for a one-time task. Omit if using cron." },
          cron: { type: "string", description: "5-part cron for recurring tasks. Omit if using run_at." },
          label: { type: "string", description: "Short human-readable name shown in /tasks list." },
          reason: { type: "string", description: "One short sentence describing what this step does." },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file. Use this to inspect plugin/theme PHP code before modifying it. " +
        "Reads from anywhere under the WordPress directory or /tmp/.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute file path, e.g. /wordpress/wp-content/plugins/myplugin/myplugin.php",
          },
          reason: { type: "string", description: "One short sentence describing why you're reading this file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file on the agent server. Use this to create or modify HTML, CSS, PHP, " +
        "or any text files. PREFERRED over run_command with cat/heredoc for writing files — " +
        "especially large HTML files. You can call this multiple times with append=true " +
        "to build up a file in chunks. " +
        "Allowed paths: /tmp/, WordPress plugins/themes/mu-plugins directories.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute file path. Allowed: /tmp/*, /wordpress/wp-content/plugins/*, /wordpress/wp-content/themes/*, /wordpress/wp-content/mu-plugins/*",
          },
          content: { type: "string", description: "The text content to write to the file." },
          append: {
            type: "boolean",
            description: "If true, append to the file instead of overwriting. Default: false.",
          },
          reason: { type: "string", description: "One short sentence describing what this step does." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply_to_forum",
      description:
        "Post a reply (comment) to a forum topic on the WordPress site. " +
        "Use this when responding to forum messages received via the /inbound channel. " +
        "Requires the post_id of the topic to reply to.",
      parameters: {
        type: "object",
        properties: {
          post_id: { type: "number", description: "The WordPress post ID of the forum topic to reply to." },
          content: { type: "string", description: "The reply content (plain text or HTML)." },
          reason: { type: "string", description: "One short sentence describing what this step does." },
        },
        required: ["post_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description:
        "Fetch a web page and return its cleaned HTML content (scripts, SVGs, iframes, " +
        "base64 data stripped). Use this to study the design/layout of any public website. " +
        "Returns cleaned HTML truncated to 20000 chars.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL to fetch, e.g. https://nytimes.com" },
          reason: { type: "string", description: "One short sentence describing why you're fetching this page." },
        },
        required: ["url"],
      },
    },
  },
];
