export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ConversationRequest {
  messages: ConversationMessage[];
  responseFormat?: "text" | "json";
  model?: string;
  temperature?: number;
}

export interface ConversationChunk {
  text: string;
  done: boolean;
}

export interface ConversationStream {
  next(): Promise<ConversationChunk | null>;
  cancel(): Promise<void>;
}

export interface ConversationalLlm {
  streamConversation(request: ConversationRequest): Promise<ConversationStream>;
  completeJson(request: ConversationRequest): Promise<JsonValue>;
}

export const POWERBOX_DESCRIPTORS = {
  conversationalLlm: "EAZQAQEAABEBF1EEAQH_xQMM-7jVG_UAAAA",
  mailEventPort: "EAZQAQEAABEBF1EEAQH_GFpNGq326PoAAAA",
  mailFeed: "EAZQAQEAABEBF1EEAQH_HR695VtMy-oAAAA",
  messageSink: "EAZQAQEAABEBF1EEAQH_O8mPdLVsBsMAAAA",
} as const;

export interface Address {
  name?: string;
  address: string;
}

export interface MailEvent {
  metadata: {
    messageKey?: string;
    messageId?: string;
    dedupeKey?: string;
    subject?: string;
    from?: Address[];
    to?: Address[];
    receivedAt?: string;
  };
  textBody?: string;
}

export interface MailEventPort {
  deliver(event: MailEvent): Promise<{ ok: true; ignored?: boolean; messageId?: string }>;
}

export type SubscriptionStart = "fromNow" | "fromBeginning";
export type DeliveryPayload = "eventOnly" | "metadataAndText" | "fullMessage";

export interface SubscriptionFilter {
  toContains: string;
  fromContains: string;
  subjectContains: string;
  includeAttachments: boolean;
}

export interface SubscriptionRequest {
  filter: SubscriptionFilter;
  start: SubscriptionStart;
  payload: DeliveryPayload;
}

export interface SubscriptionHandle {
  ok: true;
  id: string;
}

export interface MailFeed {
  addReceiver(receiver: unknown, request: SubscriptionRequest): Promise<SubscriptionHandle>;
}

export interface SenderInstruction {
  sender: string;
  policy: "always-important" | "never-important" | "llm-decides";
  notes: string;
  updatedAt: string;
}

export interface ClassificationDecision {
  important: boolean;
  confidence: number;
  summary: string;
  reason: string;
  labels: string[];
}

export interface Message {
  id: string;
  source: "mail";
  title: string;
  body: string;
  priority: "normal" | "high";
  createdAt: string;
  dedupeKey: string;
  actionUrl?: string;
  sourceRef: {
    messageKey?: string;
    messageId?: string;
    from: Address[];
    receivedAt?: string;
  };
  labels: string[];
  read?: boolean;
  archived?: boolean;
}

export interface AddMessageResult {
  ok: true;
  id: string;
  deduped: boolean;
}

export interface MessageQuery {
  includeArchived?: boolean;
  unreadOnly?: boolean;
  limit?: number;
}

export interface MessageSink {
  addMessage(message: Message): Promise<AddMessageResult>;
}

export interface MessageInbox {
  listMessages(query?: MessageQuery): Promise<Message[]>;
  markRead(id: string): Promise<void>;
  archive(id: string): Promise<void>;
}

export interface PushRequest {
  id: string;
  title: string;
  body: string;
  urgency: "normal" | "high";
  collapseKey?: string;
  deepLink?: string;
}

export interface PushResult {
  ok: true;
  delivered: number;
  attempted: number;
  errors: string[];
}

export interface PushNotification {
  sendPushNotification(notification: PushRequest): Promise<PushResult>;
}

export type OutboundHttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface OutboundHttpHeader {
  name: string;
  value: string;
}

export interface OutboundHttpSession {
  request(
    method: OutboundHttpMethod,
    path: string,
    headers: OutboundHttpHeader[],
    body: Uint8Array,
    responseStream: unknown,
  ): Promise<{
    statusCode: number;
    statusText: string;
    headers: OutboundHttpHeader[];
  }>;
}
