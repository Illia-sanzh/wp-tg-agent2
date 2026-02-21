"""
Telegram Bot — WordPress Agent Interface
────────────────────────────────────────
Receives messages from the authorized user and forwards them to the
WordPress AI agent. Streams back the result.

Features:
  • Text messages  → agent task
  • Voice messages → Whisper transcription → agent task
  • Photos         → WordPress media library upload (+ optional task if captioned)
  • /start         → welcome + feature list
  • /status        → agent health check
  • /model         → show or switch AI model
  • /cancel        → clear conversation history
  • /tasks         → list / cancel scheduled tasks
  • /skill         → list or reload custom skills
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
# Supports a single ID or a comma-separated list: "123456,789012"
ADMIN_USER_IDS = {
    int(uid.strip())
    for uid in os.environ["TELEGRAM_ADMIN_USER_ID"].split(",")
    if uid.strip()
}
AGENT_URL     = os.environ.get("AGENT_URL", "http://openclaw-agent:8080")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "claude-sonnet-4-6")

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── Auth helper ──────────────────────────────────────────────────────────────

def is_admin(update: Update) -> bool:
    return update.effective_user.id in ADMIN_USER_IDS

# ─── Command handlers ─────────────────────────────────────────────────────────

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return
    await update.message.reply_text(
        "👋 *WordPress Agent* is ready.\n\n"
        "Send a task in plain English:\n"
        "• _Create a blog post about Python tips_\n"
        "• _Install WooCommerce and create 3 products_\n"
        "• _Show me all active plugins_\n"
        "• _Publish the draft post at 5pm UTC_\n"
        "• _Update all plugins every Monday at 3am_\n\n"
        "🎙️ *Voice messages* are supported — just send a voice note!\n\n"
        "Commands:\n"
        "`/status`  — check agent health\n"
        "`/model`   — show or change AI model\n"
        "`/tasks`   — list or cancel scheduled tasks\n"
        "`/skill`   — list or reload custom skills\n"
        "`/cancel`  — cancel current task & clear history",
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        return
    try:
        r = requests.get(f"{AGENT_URL}/health", timeout=5)
        d = r.json()
        whisper = d.get("whisper", "unknown")
        jobs    = d.get("scheduled_jobs", 0)
        skills  = d.get("custom_skills", 0)
        await update.message.reply_text(
            f"✅ Agent online\n"
            f"Model: `{d.get('model', 'unknown')}`\n"
            f"Scheduler: `{d.get('scheduler', 'unknown')}` ({jobs} job(s))\n"
            f"Custom skills: `{skills}`\n"
            f"Voice (Whisper): `{whisper}`",
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
            "*Built-in models:*\n"
            "• `claude-sonnet-4-6` — default, best quality\n"
            "• `claude-haiku-4-5` — fast & cheap\n"
            "• `gpt-4o`\n"
            "• `gpt-4o-mini`\n"
            "• `deepseek-chat`\n"
            "• `gemini-2.0-flash`\n\n"
            "*OpenRouter models* (prefix with `openrouter/`):\n"
            "• `openrouter/llama-3.3-70b`\n"
            "• `openrouter/mistral-large`\n"
            "• `openrouter/gemma-3-27b`\n"
            "• `openrouter/qwq-32b`\n"
            "• Any model from openrouter.ai\n\n"
            "Usage: `/model deepseek-chat`",
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


async def cmd_tasks(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """List all scheduled tasks or cancel one by ID."""
    if not is_admin(update):
        return

    args = ctx.args or []

    # /tasks cancel <job_id>
    if args and args[0].lower() == "cancel":
        if len(args) < 2:
            await update.message.reply_text("Usage: `/tasks cancel <job_id>`", parse_mode=ParseMode.MARKDOWN)
            return
        job_id = args[1]
        try:
            r = requests.delete(f"{AGENT_URL}/schedules/{job_id}", timeout=10)
            data = r.json()
            if "error" in data:
                await update.message.reply_text(f"❌ {data['error']}")
            else:
                await update.message.reply_text(
                    f"✅ Scheduled task `{job_id}` cancelled.",
                    parse_mode=ParseMode.MARKDOWN,
                )
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {e}")
        return

    # /tasks — list all
    try:
        r = requests.get(f"{AGENT_URL}/schedules", timeout=10)
        data = r.json()
    except Exception as e:
        await update.message.reply_text(f"❌ Error fetching schedules: {e}")
        return

    jobs = data.get("jobs", [])
    if not jobs:
        await update.message.reply_text(
            "📅 No scheduled tasks.\n\n"
            "Schedule one by telling the bot:\n"
            "_\"Update all plugins every Monday at 3am UTC\"_",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    lines = ["📅 *Scheduled Tasks:*\n"]
    for job in jobs:
        lines.append(f"*{job['name']}*")
        lines.append(f"  Next run: `{job['next_run']}`")
        lines.append(f"  Trigger: `{job['trigger']}`")
        lines.append(f"  ID: `{job['id']}`")
        lines.append("")
    lines.append("To cancel: `/tasks cancel <ID>`")

    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


async def cmd_skill(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """List loaded custom skills or trigger a reload."""
    if not is_admin(update):
        return

    args = ctx.args or []

    # /skill reload
    if args and args[0].lower() == "reload":
        try:
            r = requests.post(f"{AGENT_URL}/reload-skills", timeout=15)
            data = r.json()
            loaded = data.get("loaded", 0)
            names  = data.get("skills", [])
            skills_text = "\n".join(f"• `{n}`" for n in names) if names else "_(none)_"
            await update.message.reply_text(
                f"🔄 Skills reloaded — {loaded} custom skill(s) active:\n\n{skills_text}",
                parse_mode=ParseMode.MARKDOWN,
            )
        except Exception as e:
            await update.message.reply_text(f"❌ Reload failed: {e}")
        return

    # /skill — list
    try:
        r = requests.get(f"{AGENT_URL}/skills", timeout=10)
        data = r.json()
    except Exception as e:
        await update.message.reply_text(f"❌ Error fetching skills: {e}")
        return

    builtin = data.get("builtin", [])
    custom  = data.get("custom", [])

    builtin_text = "\n".join(f"• `{n}`" for n in builtin)
    custom_text  = "\n".join(f"• `{n}`" for n in custom) if custom else "_(none — add YAML files to openclaw-config/skills/)_"

    await update.message.reply_text(
        f"🔌 *Custom Skills:*\n{custom_text}\n\n"
        f"⚙️ *Built-in Tools:*\n{builtin_text}\n\n"
        "To add a skill: create a `.yaml` file in `openclaw-config/skills/` on the server.\n"
        "See `openclaw-config/skills/README.md` for the format.\n\n"
        "To reload after adding: `/skill reload`",
        parse_mode=ParseMode.MARKDOWN,
    )


# ─── Agent streaming helper ───────────────────────────────────────────────────

async def _run_agent_task(update: Update, ctx: ContextTypes.DEFAULT_TYPE, task_text: str):
    """Stream task_text to the agent and send the result back to the user."""
    model   = ctx.user_data.get("model", DEFAULT_MODEL)
    history = ctx.user_data.get("history", [])

    status_msg = await update.message.reply_text(f"🤔 Thinking… (`{model}`)", parse_mode=ParseMode.MARKDOWN)

    loop: asyncio.AbstractEventLoop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def stream_from_agent():
        try:
            with requests.post(
                f"{AGENT_URL}/task",
                json={"message": task_text, "model": model, "history": history},
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
            asyncio.run_coroutine_threadsafe(queue.put(None), loop)

    loop.run_in_executor(None, stream_from_agent)

    result    = "(no result)"
    elapsed   = 0
    model_used = model
    steps: list[str] = []

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
            result    = event.get("text", "(no result)")
            elapsed   = event.get("elapsed", 0)
            model_used = event.get("model", model)

    history = ctx.user_data.get("history", [])
    history.append({"role": "user",      "content": task_text})
    history.append({"role": "assistant", "content": result})
    ctx.user_data["history"] = history[-10:]

    try:
        await status_msg.delete()
    except Exception:
        pass

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


# ─── Message handler ──────────────────────────────────────────────────────────

async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return
    user_text = update.message.text.strip()
    if not user_text:
        return
    await update.message.chat.send_action(ChatAction.TYPING)
    await _run_agent_task(update, ctx, user_text)


# ─── Voice message handler ────────────────────────────────────────────────────

async def handle_voice(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """
    Download a Telegram voice note (OGG Opus), send it to the agent's /transcribe
    endpoint (OpenAI Whisper), then run the transcript as a normal agent task.
    """
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return

    voice = update.message.voice
    status_msg = await update.message.reply_text("🎙️ Transcribing voice message…")

    # Download voice bytes from Telegram
    try:
        tg_file    = await voice.get_file()
        audio_bytes = bytes(await tg_file.download_as_bytearray())
    except Exception as e:
        await status_msg.edit_text(f"❌ Failed to download voice message: {e}")
        return

    # Send to agent /transcribe endpoint
    try:
        r = requests.post(
            f"{AGENT_URL}/transcribe",
            files={"file": ("voice.ogg", audio_bytes, "audio/ogg")},
            timeout=60,
        )
        data = r.json()
    except Exception as e:
        await status_msg.edit_text(f"❌ Transcription request failed: {e}")
        return

    if "error" in data:
        await status_msg.edit_text(f"❌ {data['error']}")
        return

    transcript = (data.get("text") or "").strip()
    if not transcript:
        await status_msg.edit_text("❌ Could not transcribe audio (empty result).")
        return

    # Show the user what was heard, then proceed as a normal task
    await status_msg.edit_text(
        f"🎙️ *Heard:* _{transcript}_",
        parse_mode=ParseMode.MARKDOWN,
    )
    await update.message.chat.send_action(ChatAction.TYPING)
    await _run_agent_task(update, ctx, transcript)


# ─── Photo handler ────────────────────────────────────────────────────────────

async def handle_photo(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return

    photo   = update.message.photo[-1]  # Largest available size
    caption = (update.message.caption or "").strip()

    status_msg = await update.message.reply_text("📤 Uploading to WordPress media library…")

    tg_file    = await photo.get_file()
    photo_bytes = bytes(await tg_file.download_as_bytearray())
    filename   = f"telegram_{photo.file_id}.jpg"

    try:
        r = requests.post(
            f"{AGENT_URL}/upload",
            files={"file": (filename, photo_bytes, "image/jpeg")},
            timeout=60,
        )
        data = r.json()
    except Exception as e:
        await status_msg.edit_text(f"❌ Upload failed: {e}")
        return

    if "error" in data:
        await status_msg.edit_text(f"❌ {data['error']}")
        return

    media_url = data.get("url", "")
    media_id  = data.get("id", "")

    if not caption:
        await status_msg.edit_text(
            f"✅ Uploaded to WordPress media library!\n"
            f"🆔 ID: `{media_id}`\n"
            f"🔗 {media_url}",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    # Caption present → let the agent act on it
    await status_msg.delete()
    task_text = (
        f"A photo was just uploaded to the WordPress media library "
        f"(ID: {media_id}, URL: {media_url}). {caption}"
    )
    await update.message.chat.send_action(ChatAction.TYPING)
    await _run_agent_task(update, ctx, task_text)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    logger.info(f"Starting bot (admin users: {ADMIN_USER_IDS})")

    app = (
        Application.builder()
        .token(TELEGRAM_BOT_TOKEN)
        .build()
    )

    app.add_handler(CommandHandler("start",  cmd_start))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("model",  cmd_model))
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(CommandHandler("tasks",  cmd_tasks))
    app.add_handler(CommandHandler("skill",  cmd_skill))

    app.add_handler(MessageHandler(filters.TEXT  & ~filters.COMMAND, handle_message))
    app.add_handler(MessageHandler(filters.VOICE & ~filters.COMMAND, handle_voice))
    app.add_handler(MessageHandler(filters.PHOTO & ~filters.COMMAND, handle_photo))

    logger.info("Bot is polling…")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
