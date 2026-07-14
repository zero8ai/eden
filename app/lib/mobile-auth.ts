export const mobileTrustedOrigins = (nodeEnv = process.env.NODE_ENV) => [
  "eden://",
  "eden://*",
  ...(nodeEnv === "development"
    ? ["exp://*", "exp://localhost:*", "exp://127.0.0.1:*"]
    : []),
];
