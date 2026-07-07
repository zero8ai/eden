import { telegramChannel } from "eve/channels/telegram";

// Credentials come from the TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET_TOKEN
// environment variables (set them as agent secrets in Eden). Set botUsername to
// your bot's @name to enable @mention dispatch in group chats.
export default telegramChannel({});
