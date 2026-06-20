import { logger } from '@/lib/logger';
import { isTauriRuntime, tauriInvoke, tauriListen } from '@/lib/runtime-env';
import type {
  RemoteChannelAdapter,
  RemoteChannelCapabilities,
  RemoteChannelStatus,
} from '@/services/remote/remote-channel-types';
import { parseAllowedChatIds } from '@/services/remote/telegram-remote-utils';
import { useSettingsStore } from '@/stores/settings-store';
import type {
  RemoteAttachment,
  RemoteEditMessageRequest,
  RemoteInboundMessage,
  RemoteSendMessageRequest,
  RemoteSendMessageResponse,
  TelegramEditMessageRequest,
  TelegramGatewayStatus,
  TelegramInboundMessage,
  TelegramRemoteAttachment,
  TelegramRemoteConfig,
  TelegramSendMessageRequest,
  TelegramSendMessageResponse,
} from '@/types/remote-control';

function toRemoteAttachment(attachment: TelegramRemoteAttachment): RemoteAttachment {
  return {
    id: attachment.id,
    type: attachment.attachmentType,
    filePath: attachment.filePath,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    durationSeconds: attachment.durationSeconds,
    caption: attachment.caption,
  };
}

function toRemoteInboundMessage(message: TelegramInboundMessage): RemoteInboundMessage {
  return {
    channelId: 'telegram',
    chatId: String(message.chatId),
    messageId: String(message.messageId),
    text: message.text,
    username: message.username ?? null,
    firstName: message.firstName ?? null,
    lastName: message.lastName ?? null,
    date: message.date,
    attachments: message.attachments
      ? message.attachments.map((attachment) => toRemoteAttachment(attachment))
      : [],
  };
}

function toTelegramSendMessageRequest(
  request: RemoteSendMessageRequest
): TelegramSendMessageRequest {
  return {
    chatId: Number(request.chatId),
    text: request.text,
    replyToMessageId: request.replyToMessageId ? Number(request.replyToMessageId) : undefined,
    disableWebPagePreview: request.disableWebPagePreview,
    parseMode: request.parseMode,
  };
}

function toTelegramEditMessageRequest(
  request: RemoteEditMessageRequest
): TelegramEditMessageRequest {
  return {
    chatId: Number(request.chatId),
    messageId: Number(request.messageId),
    text: request.text,
    disableWebPagePreview: request.disableWebPagePreview,
    parseMode: request.parseMode,
  };
}

export class TelegramChannelAdapter implements RemoteChannelAdapter {
  readonly channelId = 'telegram' as const;
  readonly capabilities: RemoteChannelCapabilities = {
    supportsEdit: true,
    supportsReply: true,
    supportsMediaSend: false,
    supportsVoiceInput: true,
    supportsProactiveMessage: true,
    maxMessageLength: 4096,
    streamMode: 'edit',
  };
  private inboundUnlisten: (() => void) | null = null;

  async start(): Promise<void> {
    if (!isTauriRuntime()) {
      logger.warn('[TelegramChannelAdapter] Not available in web mode');
      return;
    }

    const settings = useSettingsStore.getState();
    const config = this.toRustConfig(settings);

    // Always sync the latest UI state so Rust cannot keep polling with stale config.
    await tauriInvoke('telegram_set_config', { config });

    if (!config.enabled || !config.token) {
      logger.info('[TelegramChannelAdapter] Remote control disabled or missing token');
      await tauriInvoke('telegram_stop');
      return;
    }

    logger.info('[TelegramChannelAdapter] Starting gateway');
    await tauriInvoke('telegram_start');
  }

  async stop(): Promise<void> {
    logger.info('[TelegramChannelAdapter] Stopping gateway');
    if (!isTauriRuntime()) return;
    await tauriInvoke('telegram_stop');
  }

  onInbound(handler: (message: RemoteInboundMessage) => void): () => void {
    const listenPromise = tauriListen<TelegramInboundMessage>(
      'telegram-inbound-message',
      (payload) => {
        logger.debug('[TelegramChannelAdapter] Inbound event received', payload);
        handler(toRemoteInboundMessage(payload));
      }
    );

    listenPromise
      .then((unlisten) => {
        this.inboundUnlisten = unlisten;
      })
      .catch((error: unknown) => {
        logger.warn('[TelegramChannelAdapter] Failed to listen inbound', error);
      });

    return () => {
      if (this.inboundUnlisten) {
        this.inboundUnlisten();
        this.inboundUnlisten = null;
      }
    };
  }

  async sendMessage(request: RemoteSendMessageRequest): Promise<RemoteSendMessageResponse> {
    logger.debug('[TelegramChannelAdapter] sendMessage', {
      chatId: request.chatId,
      textLen: request.text.length,
      replyToMessageId: request.replyToMessageId,
    });
    const response = await tauriInvoke<TelegramSendMessageResponse>('telegram_send_message', {
      request: toTelegramSendMessageRequest(request),
    });
    return { messageId: String(response.messageId) };
  }

  async editMessage(request: RemoteEditMessageRequest): Promise<void> {
    logger.debug('[TelegramChannelAdapter] editMessage', {
      chatId: request.chatId,
      messageId: request.messageId,
      textLen: request.text.length,
    });
    await tauriInvoke('telegram_edit_message', {
      request: toTelegramEditMessageRequest(request),
    });
  }

  async getStatus(): Promise<RemoteChannelStatus> {
    const status = await tauriInvoke<TelegramGatewayStatus>('telegram_get_status');
    return {
      running: status.running,
      lastPollAtMs: status.lastPollAtMs ?? null,
      lastError: status.lastError ?? null,
      lastErrorAtMs: status.lastErrorAtMs ?? null,
      details: {
        lastUpdateId: status.lastUpdateId ?? null,
        backoffMs: status.backoffMs ?? null,
      },
    };
  }

  async getConfig(): Promise<TelegramRemoteConfig> {
    return tauriInvoke('telegram_get_config');
  }

  private toRustConfig(
    settings: ReturnType<typeof useSettingsStore.getState>
  ): TelegramRemoteConfig {
    return {
      enabled: settings.telegram_remote_enabled,
      token: settings.telegram_remote_token.trim(),
      allowedChatIds: parseAllowedChatIds(settings.telegram_remote_allowed_chats),
      pollTimeoutSecs: Number(settings.telegram_remote_poll_timeout || '25'),
    };
  }
}
