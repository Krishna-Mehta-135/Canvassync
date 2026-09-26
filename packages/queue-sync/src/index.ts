import amqp, {
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from "amqplib";
import { once } from "node:events";
import type { Shape } from "@repo/canvas-engine";
import {
  RABBITMQ_DB_PERSIST_EXCHANGE,
  RABBITMQ_DB_PERSIST_QUEUE,
  RABBITMQ_DB_PERSIST_ROUTING_KEY,
  RABBITMQ_PREFETCH,
  RABBITMQ_ROOM_EVENTS_EXCHANGE,
  RABBITMQ_ROOM_EVENTS_PARTITIONS,
  RABBITMQ_ROOM_EVENTS_QUEUE_PREFIX,
  RABBITMQ_URL,
  RABBITMQ_AI_GENERATE_EXCHANGE,
  RABBITMQ_AI_GENERATE_QUEUE,
  RABBITMQ_AI_GENERATE_ROUTING_KEY,
} from "@repo/backend-common/config";
import {
  RoomSnapshotBroadcastEventSchema,
  type RoomSnapshotBroadcastEvent,
} from "@repo/common/ws-protocol";
import { z } from "zod";

const DbPersistShapeSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.string().min(1).max(64),
  })
  .passthrough();

const RoomPersistJobSchema = z.object({
  jobId: z.string().min(8).max(128),
  roomId: z.number().int().positive(),
  version: z.number().int().min(1),
  shapes: z.array(DbPersistShapeSchema).max(5000),
  enqueuedAtMs: z.number().int().nonnegative(),
});

export type RoomPersistJob = {
  jobId: string;
  roomId: number;
  version: number;
  shapes: Shape[];
  enqueuedAtMs: number;
};

// AI canvas generation job
const AiGenerateJobSchema = z.object({
  jobId: z.string().min(8).max(128),
  roomId: z.number().int().positive(),
  // Keep in sync with AiGenerateRequestSchema max length in @repo/common.
  prompt: z.string().min(1).max(12000),
  requestedBy: z.string().optional(),
  mode: z.enum(["generate", "edit"]).optional(),
  // Shapes to rewrite in "edit" mode (already validated by the HTTP backend).
  selection: z.array(z.record(z.string(), z.unknown())).max(120).optional(),
  enqueuedAtMs: z.number().int().nonnegative(),
});

export type AiGenerateJob = {
  jobId: string;
  roomId: number;
  prompt: string;
  requestedBy?: string;
  mode?: "generate" | "edit";
  selection?: Record<string, unknown>[];
  enqueuedAtMs: number;
};

let publisherConnection: ChannelModel | null = null;
let publisherChannel: ConfirmChannel | null = null;
let subscriberConnection: ChannelModel | null = null;
let subscriberChannel: Channel | null = null;
let persistSubscriberConnection: ChannelModel | null = null;
let persistSubscriberChannel: Channel | null = null;
let aiSubscriberConnection: ChannelModel | null = null;
let aiSubscriberChannel: Channel | null = null;
let activeConsumerTag: string | null = null;
let activePersistConsumerTag: string | null = null;
let activeAiConsumerTag: string | null = null;
let subscribedNodeId: string | null = null;
let subscribedHandler:
  | ((event: RoomSnapshotBroadcastEvent) => void | Promise<void>)
  | null = null;
let persistSubscribedHandler:
  | ((job: RoomPersistJob) => void | Promise<void>)
  | null = null;
let aiSubscribedHandler: ((job: AiGenerateJob) => void | Promise<void>) | null =
  null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let persistReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let aiReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function normalizePositiveInt(value: number, fallback: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function roomPartition(roomId: number) {
  const partitions = normalizePositiveInt(RABBITMQ_ROOM_EVENTS_PARTITIONS, 16);
  return roomId % partitions;
}

function partitionRoutingKey(partition: number) {
  return `room.partition.${partition}`;
}

async function assertExchange(channel: Channel) {
  await channel.assertExchange(RABBITMQ_ROOM_EVENTS_EXCHANGE, "direct", {
    durable: true,
  });
}

async function createPublisherChannel() {
  publisherConnection = await amqp.connect(RABBITMQ_URL);
  const connection = publisherConnection;

  connection.on("error", (error) => {
    console.error("[WS][RabbitMQ] publisher connection error", error);
  });
  connection.on("close", () => {
    publisherConnection = null;
    publisherChannel = null;
  });

  const channel = await connection.createConfirmChannel();
  publisherChannel = channel;
  await assertExchange(channel);
  await channel.assertExchange(RABBITMQ_DB_PERSIST_EXCHANGE, "direct", {
    durable: true,
  });
  await channel.assertExchange(RABBITMQ_AI_GENERATE_EXCHANGE, "direct", {
    durable: true,
  });
}

async function createSubscriberChannel(nodeId: string) {
  subscriberConnection = await amqp.connect(RABBITMQ_URL);
  const connection = subscriberConnection;

  connection.on("error", (error) => {
    console.error("[WS][RabbitMQ] subscriber connection error", error);
  });
  connection.on("close", () => {
    subscriberConnection = null;
    subscriberChannel = null;
    activeConsumerTag = null;

    if (subscribedNodeId && subscribedHandler) {
      scheduleResubscribe(subscribedNodeId, subscribedHandler);
    }
  });

  const channel = await connection.createChannel();
  subscriberChannel = channel;
  await assertExchange(channel);

  const queueName = `${RABBITMQ_ROOM_EVENTS_QUEUE_PREFIX}.${nodeId}`;

  const queueOptions: Options.AssertQueue = {
    durable: true,
    arguments: {
      // Prevent dead queues from living forever if a node is removed.
      "x-expires": 24 * 60 * 60 * 1000,
    },
  };

  const assertedQueue = await channel.assertQueue(queueName, queueOptions);

  const partitions = normalizePositiveInt(RABBITMQ_ROOM_EVENTS_PARTITIONS, 16);
  for (let partition = 0; partition < partitions; partition += 1) {
    await channel.bindQueue(
      assertedQueue.queue,
      RABBITMQ_ROOM_EVENTS_EXCHANGE,
      partitionRoutingKey(partition),
    );
  }

  await channel.prefetch(normalizePositiveInt(RABBITMQ_PREFETCH, 200));

  return assertedQueue.queue;
}

async function createPersistSubscriberChannel() {
  persistSubscriberConnection = await amqp.connect(RABBITMQ_URL);
  const connection = persistSubscriberConnection;

  connection.on("error", (error) => {
    console.error("[WS][RabbitMQ] persist subscriber connection error", error);
  });

  connection.on("close", () => {
    persistSubscriberConnection = null;
    persistSubscriberChannel = null;
    activePersistConsumerTag = null;

    if (persistSubscribedHandler) {
      schedulePersistResubscribe(persistSubscribedHandler);
    }
  });

  const channel = await connection.createChannel();
  persistSubscriberChannel = channel;
  await channel.assertExchange(RABBITMQ_DB_PERSIST_EXCHANGE, "direct", {
    durable: true,
  });
  await channel.assertQueue(RABBITMQ_DB_PERSIST_QUEUE, {
    durable: true,
  });
  await channel.bindQueue(
    RABBITMQ_DB_PERSIST_QUEUE,
    RABBITMQ_DB_PERSIST_EXCHANGE,
    RABBITMQ_DB_PERSIST_ROUTING_KEY,
  );
  await channel.prefetch(normalizePositiveInt(RABBITMQ_PREFETCH, 200));
}

async function createAiSubscriberChannel() {
  aiSubscriberConnection = await amqp.connect(RABBITMQ_URL);
  const connection = aiSubscriberConnection;

  connection.on("error", (error) => {
    console.error("[AI][RabbitMQ] ai subscriber connection error", error);
  });

  connection.on("close", () => {
    aiSubscriberConnection = null;
    aiSubscriberChannel = null;
    activeAiConsumerTag = null;

    if (aiSubscribedHandler) {
      scheduleAiResubscribe(aiSubscribedHandler);
    }
  });

  const channel = await connection.createChannel();
  aiSubscriberChannel = channel;
  await channel.assertExchange(RABBITMQ_AI_GENERATE_EXCHANGE, "direct", {
    durable: true,
  });
  await channel.assertQueue(RABBITMQ_AI_GENERATE_QUEUE, {
    durable: true,
  });
  await channel.bindQueue(
    RABBITMQ_AI_GENERATE_QUEUE,
    RABBITMQ_AI_GENERATE_EXCHANGE,
    RABBITMQ_AI_GENERATE_ROUTING_KEY,
  );
  await channel.prefetch(normalizePositiveInt(RABBITMQ_PREFETCH, 200));
}

async function ensurePublisherChannel() {
  if (publisherConnection && publisherChannel) {
    return;
  }

  await createPublisherChannel();
}

function scheduleResubscribe(
  nodeId: string,
  handler: (event: RoomSnapshotBroadcastEvent) => void | Promise<void>,
) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void subscribeDurableRoomEvents(nodeId, handler);
  }, 1000);
}

function schedulePersistResubscribe(
  handler: (job: RoomPersistJob) => void | Promise<void>,
) {
  if (persistReconnectTimer) {
    clearTimeout(persistReconnectTimer);
  }

  persistReconnectTimer = setTimeout(() => {
    persistReconnectTimer = null;
    void subscribeRoomPersistJobs(handler);
  }, 1000);
}

function scheduleAiResubscribe(
  handler: (job: AiGenerateJob) => void | Promise<void>,
) {
  if (aiReconnectTimer) {
    clearTimeout(aiReconnectTimer);
  }

  aiReconnectTimer = setTimeout(() => {
    aiReconnectTimer = null;
    void subscribeAiGenerateJobs(handler);
  }, 1000);
}

export async function publishDurableRoomEvent(
  event: RoomSnapshotBroadcastEvent,
) {
  const validatedEvent = RoomSnapshotBroadcastEventSchema.parse(event);
  await ensurePublisherChannel();

  const routingKey = partitionRoutingKey(roomPartition(validatedEvent.roomId));
  const content = Buffer.from(JSON.stringify(validatedEvent));

  const acceptedByBuffer = publisherChannel!.publish(
    RABBITMQ_ROOM_EVENTS_EXCHANGE,
    routingKey,
    content,
    {
      persistent: true,
      contentType: "application/json",
      timestamp: validatedEvent.publishedAtMs,
      messageId: validatedEvent.actionId,
      type: validatedEvent.type,
    },
  );

  if (!acceptedByBuffer) {
    await once(publisherChannel!, "drain");
  }

  await publisherChannel!.waitForConfirms();
}

async function consumeMessage(
  message: ConsumeMessage,
  handler: (event: RoomSnapshotBroadcastEvent) => void | Promise<void>,
) {
  if (!subscriberChannel) {
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(message.content.toString("utf8"));
  } catch {
    subscriberChannel.ack(message);
    return;
  }

  const parsed = RoomSnapshotBroadcastEventSchema.safeParse(payload);
  if (!parsed.success) {
    subscriberChannel.ack(message);
    return;
  }

  const normalizedEvent: RoomSnapshotBroadcastEvent = {
    ...parsed.data,
    shapes: parsed.data.shapes as Shape[],
  };

  try {
    await handler(normalizedEvent);
    subscriberChannel.ack(message);
  } catch (error) {
    console.error("[WS][RabbitMQ] failed to process durable room event", error);
    subscriberChannel.nack(message, false, true);
  }
}

async function consumePersistMessage(
  message: ConsumeMessage,
  handler: (job: RoomPersistJob) => void | Promise<void>,
) {
  if (!persistSubscriberChannel) {
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(message.content.toString("utf8"));
  } catch {
    persistSubscriberChannel.ack(message);
    return;
  }

  const parsed = RoomPersistJobSchema.safeParse(payload);
  if (!parsed.success) {
    persistSubscriberChannel.ack(message);
    return;
  }

  const job: RoomPersistJob = {
    ...parsed.data,
    shapes: parsed.data.shapes as Shape[],
  };

  try {
    await handler(job);
    persistSubscriberChannel.ack(message);
  } catch (error) {
    console.error("[WS][RabbitMQ] failed to process room persist job", error);
    persistSubscriberChannel.nack(message, false, true);
  }
}

async function consumeAiMessage(
  message: ConsumeMessage,
  handler: (job: AiGenerateJob) => void | Promise<void>,
) {
  if (!aiSubscriberChannel) {
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(message.content.toString("utf8"));
  } catch {
    aiSubscriberChannel.ack(message);
    return;
  }

  const parsed = AiGenerateJobSchema.safeParse(payload);
  if (!parsed.success) {
    aiSubscriberChannel.ack(message);
    return;
  }

  const job: AiGenerateJob = parsed.data;

  try {
    await handler(job);
    aiSubscriberChannel.ack(message);
  } catch (error) {
    console.error("[AI][RabbitMQ] failed to process AI generate job", error);
    aiSubscriberChannel.nack(message, false, true);
  }
}

export async function publishRoomPersistJob(job: RoomPersistJob) {
  const validatedJob = RoomPersistJobSchema.parse(job);
  await ensurePublisherChannel();

  const acceptedByBuffer = publisherChannel!.publish(
    RABBITMQ_DB_PERSIST_EXCHANGE,
    RABBITMQ_DB_PERSIST_ROUTING_KEY,
    Buffer.from(JSON.stringify(validatedJob)),
    {
      persistent: true,
      contentType: "application/json",
      timestamp: validatedJob.enqueuedAtMs,
      messageId: validatedJob.jobId,
      type: "room_persist_job",
    },
  );

  if (!acceptedByBuffer) {
    await once(publisherChannel!, "drain");
  }

  await publisherChannel!.waitForConfirms();
}

export async function publishAiGenerateJob(job: AiGenerateJob) {
  const validatedJob = AiGenerateJobSchema.parse(job);
  await ensurePublisherChannel();

  const acceptedByBuffer = publisherChannel!.publish(
    RABBITMQ_AI_GENERATE_EXCHANGE,
    RABBITMQ_AI_GENERATE_ROUTING_KEY,
    Buffer.from(JSON.stringify(validatedJob)),
    {
      persistent: true,
      contentType: "application/json",
      timestamp: validatedJob.enqueuedAtMs,
      messageId: validatedJob.jobId,
      type: "ai_generate_job",
    },
  );

  if (!acceptedByBuffer) {
    await once(publisherChannel!, "drain");
  }

  await publisherChannel!.waitForConfirms();
}

export async function subscribeRoomPersistJobs(
  handler: (job: RoomPersistJob) => void | Promise<void>,
) {
  persistSubscribedHandler = handler;

  if (!persistSubscriberConnection || !persistSubscriberChannel) {
    await createPersistSubscriberChannel();
  }

  if (activePersistConsumerTag) {
    return;
  }

  const consumeResult = await persistSubscriberChannel!.consume(
    RABBITMQ_DB_PERSIST_QUEUE,
    (message) => {
      if (!message) {
        return;
      }

      void consumePersistMessage(message, handler);
    },
    {
      noAck: false,
    },
  );

  activePersistConsumerTag = consumeResult.consumerTag;
}

export async function subscribeAiGenerateJobs(
  handler: (job: AiGenerateJob) => void | Promise<void>,
) {
  aiSubscribedHandler = handler;

  if (!aiSubscriberConnection || !aiSubscriberChannel) {
    await createAiSubscriberChannel();
  }

  if (activeAiConsumerTag) {
    return;
  }

  const consumeResult = await aiSubscriberChannel!.consume(
    RABBITMQ_AI_GENERATE_QUEUE,
    (message) => {
      if (!message) {
        return;
      }

      void consumeAiMessage(message, handler);
    },
    {
      noAck: false,
    },
  );

  activeAiConsumerTag = consumeResult.consumerTag;
}

export async function subscribeDurableRoomEvents(
  nodeId: string,
  handler: (event: RoomSnapshotBroadcastEvent) => void | Promise<void>,
) {
  subscribedNodeId = nodeId;
  subscribedHandler = handler;

  if (!subscriberConnection || !subscriberChannel) {
    const queue = await createSubscriberChannel(nodeId);

    const consumeResult = await subscriberChannel!.consume(
      queue,
      (message) => {
        if (!message) {
          return;
        }

        void consumeMessage(message, handler);
      },
      {
        noAck: false,
      },
    );

    activeConsumerTag = consumeResult.consumerTag;
    return;
  }

  if (activeConsumerTag) {
    return;
  }

  const queue = `${RABBITMQ_ROOM_EVENTS_QUEUE_PREFIX}.${nodeId}`;
  const consumeResult = await subscriberChannel.consume(
    queue,
    (message) => {
      if (!message) {
        return;
      }

      void consumeMessage(message, handler);
    },
    {
      noAck: false,
    },
  );

  activeConsumerTag = consumeResult.consumerTag;
}

export async function closeDurableRoomEventBus() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (persistReconnectTimer) {
    clearTimeout(persistReconnectTimer);
    persistReconnectTimer = null;
  }

  if (aiReconnectTimer) {
    clearTimeout(aiReconnectTimer);
    aiReconnectTimer = null;
  }

  try {
    if (subscriberChannel && activeConsumerTag) {
      await subscriberChannel.cancel(activeConsumerTag);
      activeConsumerTag = null;
    }

    if (persistSubscriberChannel && activePersistConsumerTag) {
      await persistSubscriberChannel.cancel(activePersistConsumerTag);
      activePersistConsumerTag = null;
    }

    if (aiSubscriberChannel && activeAiConsumerTag) {
      await aiSubscriberChannel.cancel(activeAiConsumerTag);
      activeAiConsumerTag = null;
    }
  } catch {
    // Ignore shutdown races.
  }

  await Promise.all([
    subscriberChannel?.close().catch(() => undefined),
    subscriberConnection?.close().catch(() => undefined),
    persistSubscriberChannel?.close().catch(() => undefined),
    persistSubscriberConnection?.close().catch(() => undefined),
    aiSubscriberChannel?.close().catch(() => undefined),
    aiSubscriberConnection?.close().catch(() => undefined),
    publisherChannel?.close().catch(() => undefined),
    publisherConnection?.close().catch(() => undefined),
  ]);

  subscriberChannel = null;
  subscriberConnection = null;
  persistSubscriberChannel = null;
  persistSubscriberConnection = null;
  aiSubscriberChannel = null;
  aiSubscriberConnection = null;
  publisherChannel = null;
  publisherConnection = null;
  activePersistConsumerTag = null;
  activeAiConsumerTag = null;
  subscribedNodeId = null;
  subscribedHandler = null;
  persistSubscribedHandler = null;
  aiSubscribedHandler = null;
}
