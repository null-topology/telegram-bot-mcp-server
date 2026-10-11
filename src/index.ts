import { startServer } from "./server";

const token = process.env.TELEGRAM_BOT_API_TOKEN;
if (!token) {
  console.error("No bot token");
  process.exit(1);
}

void startServer(token);
