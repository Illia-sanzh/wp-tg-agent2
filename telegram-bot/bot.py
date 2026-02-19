"""
Telegram Bot — WordPress Agent Interface
────────────────────────────────────────
Receives messages from the authorized user and forwards them to the
WordPress AI agent. Streams back the result.
"""

import logging
import os
import time

import requests
from telegram import Update, BotCommand
from telegram.constants import ParseMode, ChatAction
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

# ─── Config ───────────────────────────────────────────────────────────────────

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
ADMIN_USER_ID = int(os.environ["TELEGRAM_ADMIN_USER_ID"])
AGENT_URL = os.environ.get("AGENT_URL", "http://openclaw-agent:8080")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "claude-sonnet-4-6")

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── Auth helper ──────────────────────────────────────────────────────────────

def is_admin(update: Update) -> bool:
    return update.effective_user.id == ADMIN_USER_ID

# ─── Command handlers ─────────────────────────────────────────────────────────

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return
    await update.message.reply_text(
        "👋 *WordPress Agent* is ready.\n\n"
        "Just send me a task in plain English:\n"
        "• _Create a blog post about Python tips_\n"
        "• _Install WooCommerce and create 3 products_\n"
        "• _Show me all active plugins_\n"
        "• _Change the site tagline to \"Fast & Reliable\"_\n\n"
        "Commands:\n"
        "/status — check agent health\n"
        "/model — show or change AI model\n"
        "/cancel — cancel current task",
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        return
    try:
        r = requests.get(f"{AGENT_URL}/health", timeout=5)
        data = r.json()
        await update.message.reply_text(
            f"✅ Agent online\nModel: `{data.get('model', 'unknown')}`",
            parse_mode=ParseMode.MARKDOWN,
        )
    except Exception as e:
        await update.message.reply_text(f"❌ Agent unreachable: {e}")


async def cmd_model(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        return
    args = ctx.args
    if not args:
        current = ctx.user_data.get("model", DEFAULT_MODEL)
        await update.message.reply_text(
            f"Current model: `{current}`\n\n"
            "Available models:\n"
            "• `claude-sonnet-4-6` (default, best)\n"
            "• `claude-haiku-4-5` (fast, cheap)\n"
            "• `gpt-4o`\n"
            "• `gpt-4o-mini`\n"
            "• `deepseek-chat`\n"
            "• `gemini-2.0-flash`\n\n"
            "Usage: `/model claude-haiku-4-5`",
            parse_mode=ParseMode.MARKDOWN,
        )
        return
    model = args[0].strip()
    ctx.user_data["model"] = model
    await update.message.reply_text(f"✅ Switched to model: `{model}`", parse_mode=ParseMode.MARKDOWN)


async def cmd_cancel(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        return
    ctx.user_data.pop("running", None)
    await update.message.reply_text("🛑 Task cancelled (if one was running).")


# ─── Message handler ──────────────────────────────────────────────────────────

async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return

    user_text = update.message.text.strip()
    if not user_text:
        return

    model = ctx.user_data.get("model", DEFAULT_MODEL)

    # Send "typing..." indicator
    await update.message.chat.send_action(ChatAction.TYPING)

    # Show a "working" message
    working_msg = await update.message.reply_text(
        f"⚙️ Working on it… (model: `{model}`)",
        parse_mode=ParseMode.MARKDOWN,
    )

    # Keep typing indicator alive while processing
    start_time = time.time()
    try:
        r = requests.post(
            f"{AGENT_URL}/task",
            json={"message": user_text, "model": model},
            timeout=300,
        )
        r.raise_for_status()
        data = r.json()
        result = data.get("result", "(no result)")
        elapsed = data.get("elapsed_seconds", 0)
    except requests.exceptions.Timeout:
        result = "⏱️ The task timed out after 5 minutes. It may still be running on the server."
        elapsed = 300
    except requests.exceptions.ConnectionError:
        result = "❌ Agent is unreachable. Check if the containers are running."
        elapsed = 0
    except Exception as e:
        result = f"❌ Error: {e}"
        elapsed = round(time.time() - start_time, 1)

    # Delete "working" message
    try:
        await working_msg.delete()
    except Exception:
        pass

    # Split long results into chunks (Telegram limit: 4096 chars)
    MAX_LEN = 4000
    if len(result) <= MAX_LEN:
        chunks = [result]
    else:
        chunks = []
        while result:
            chunks.append(result[:MAX_LEN])
            result = result[MAX_LEN:]

    footer = f"\n\n_⏱ {elapsed}s • {model}_"

    for i, chunk in enumerate(chunks):
        text = chunk
        if i == len(chunks) - 1:
            text += footer
        try:
            await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)
        except Exception:
            # Fallback: send as plain text if Markdown fails
            try:
                await update.message.reply_text(text)
            except Exception as e2:
                logger.error(f"Failed to send message chunk: {e2}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    logger.info(f"Starting bot (admin user: {ADMIN_USER_ID})")

    app = (
        Application.builder()
        .token(TELEGRAM_BOT_TOKEN)
        .build()
    )

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("model", cmd_model))
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Bot is polling...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
