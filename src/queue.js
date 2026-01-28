import bullmq from "bullmq";
import Redis from "ioredis";

const { Queue } = bullmq;

const redisUrl = process.env.REDIS_URL;
export const redis = new Redis(redisUrl);

export const agentQueue = new Queue("agent-queue", {
  connection: { url: redisUrl }
});
