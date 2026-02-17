# Telegram Setup

[中文](./telegram_CN.md) | English

Telegram is the simplest platform to set up — you only need a single Bot Token, and the entire process is done within the Telegram chat interface. No web console required.

For an overview of messaging integration, see [Messaging Integration Guide](./README.md).

---

## Step 1: Create a Bot via BotFather

1. Open your Telegram client (mobile or desktop)
2. Search for **@BotFather** and start a conversation (this is Telegram's official bot management tool)
3. Send the `/newbot` command
4. Follow the prompts to set:
   - **Bot display name** (e.g. `My Agent`, can be anything)
   - **Bot username** (must end with `bot`, e.g. `my_sf_agent_bot`, must be globally unique)
5. Once created, BotFather will return a **Bot Token** in the format `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

> Copy and save this token — you'll need it in SFTerminal.

---

## Step 2: (Optional) Allow the Bot to Join Groups

If you want to use the bot in group chats:

1. Send `/mybots` to @BotFather
2. Select the bot you just created
3. Go to **Bot Settings** → **Allow Groups?** → Select **Turn on**

> Skip this step if you only plan to use the bot in private chats.

---

## Next Steps

In SFTerminal, go to **Settings** → **Remote Access**, expand the **Telegram** card, enter the **Bot Token**, and click **Connect**. See [Connect in SFTerminal](./README.md#connect-in-sfterminal) for full usage and FAQ.
