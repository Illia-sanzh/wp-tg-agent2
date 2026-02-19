"""
Telegram Bot — WordPress Agent Interface
────────────────────────────────────────
Receives messages from the authorized user and forwards them to the
WordPress AI agent. Streams back the result.
"""

import asyncio
import json
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
    ctx.user_data.pop("history", None)
    await update.message.reply_text("🛑 Task cancelled and conversation history cleared.")


# ─── Message handler ──────────────────────────────────────────────────────────

async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return

    user_text = update.message.text.strip()
    if not user_text:
        return

    model = ctx.user_data.get("model", DEFAULT_MODEL)
    history = ctx.user_data.get("history", [])

    await update.message.chat.send_action(ChatAction.TYPING)

    # Single status message — updated in-place as the agent works
    status_msg = await update.message.reply_text(f"🤔 Thinking… (`{model}`)", parse_mode=ParseMode.MARKDOWN)

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def stream_from_agent():
        """Run in a thread: POSTs to agent and pushes ndjson events into the queue."""
        try:
            with requests.post(
                f"{AGENT_URL}/task",
                json={"message": user_text, "model": model, "history": history},
                stream=True,
                timeout=310,
            ) as r:
                r.raise_for_status()
                for raw in r.iter_lines(decode_unicode=True):
                    if raw:
                        try:
                            asyncio.run_coroutine_threadsafe(queue.put(json.loads(raw)), loop)
                        except Exception:
                            pass
        except requests.exceptions.Timeout:
            asyncio.run_coroutine_threadsafe(
                queue.put({"type": "result", "text": "⏱️ Timed out after 5 minutes.", "elapsed": 300, "model": model}), loop
            )
        except requests.exceptions.ConnectionError:
            asyncio.run_coroutine_threadsafe(
                queue.put({"type": "result", "text": "❌ Agent is unreachable.", "elapsed": 0, "model": model}), loop
            )
        except Exception as e:
            asyncio.run_coroutine_threadsafe(
                queue.put({"type": "result", "text": f"❌ Error: {e}", "elapsed": 0, "model": model}), loop
            )
        finally:
            asyncio.run_coroutine_threadsafe(queue.put(None), loop)  # sentinel

    loop.run_in_executor(None, stream_from_agent)

    result = "(no result)"
    elapsed = 0
    model_used = model
    steps = []

    def build_status() -> str:
        lines = ["🤔 Thinking…"]
        if steps:
            lines.append("")
            for i, s in enumerate(steps, 1):
                lines.append(f"{i}. {s}")
        return "\n".join(lines)

    while True:
        event = await queue.get()
        if event is None:
            break

        etype = event.get("type")

        if etype == "progress":
            steps.append(event.get("text", "⚙️ Working…"))
            try:
                await status_msg.edit_text(build_status())
            except Exception:
                pass

        elif etype == "thinking":
            try:
                await status_msg.edit_text(build_status())
            except Exception:
                pass

        elif etype == "result":
            result = event.get("text", "(no result)")
            elapsed = event.get("elapsed", 0)
            model_used = event.get("model", model)

    # Save this exchange to history (last 5 turns = 10 messages)
    history = ctx.user_data.get("history", [])
    history.append({"role": "user", "content": user_text})
    history.append({"role": "assistant", "content": result})
    ctx.user_data["history"] = history[-10:]

    # Remove status message
    try:
        await status_msg.delete()
    except Exception:
        pass

    # Send final result, split into 4000-char chunks if needed
    MAX_LEN = 4000
    chunks = [result[i:i + MAX_LEN] for i in range(0, max(len(result), 1), MAX_LEN)]
    footer = f"\n\n_⏱ {elapsed}s • {model_used}_"

    for i, chunk in enumerate(chunks):
        text = chunk + (footer if i == len(chunks) - 1 else "")
        try:
            await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)
        except Exception:
            try:
                await update.message.reply_text(text)
            except Exception as e2:
                logger.error(f"Failed to send chunk: {e2}")


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
