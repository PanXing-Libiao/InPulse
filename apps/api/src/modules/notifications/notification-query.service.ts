import {
  TimeCursorError,
  TimeCursorService,
  type TimeCursorValue,
} from "../../cursors/time-cursor.js";
import {
  InvalidMutedProjectCategoriesError,
  notificationMuteRules,
} from "./notification-muted-categories.js";
import {
  NotificationStateService,
  type NotificationItem,
} from "./notification.service.js";

export const NOTIFICATION_PAGE_LIMIT_DEFAULT = 20;
export const NOTIFICATION_PAGE_LIMIT_MAX = 50;

export interface NotificationQueryCommand {
  readonly actorUserId: number;
  readonly unreadOnly?: boolean;
  readonly limit?: number;
  readonly after?: string;
  readonly mutedProjectCategories?: string;
}

export interface NotificationQueryPage {
  readonly items: readonly NotificationItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export class NotificationQueryValidationError extends Error {
  readonly status: "invalid-limit" | "invalid-cursor" | "invalid-mute";

  constructor(
    status: NotificationQueryValidationError["status"],
    message: string,
  ) {
    super(message);
    this.name = "NotificationQueryValidationError";
    this.status = status;
  }
}

function parseLimit(limit: number | undefined): number {
  const value = limit ?? NOTIFICATION_PAGE_LIMIT_DEFAULT;
  if (!Number.isInteger(value) || value < 1) {
    throw new NotificationQueryValidationError(
      "invalid-limit",
      "limit must be a positive integer",
    );
  }
  return Math.min(value, NOTIFICATION_PAGE_LIMIT_MAX);
}

export class NotificationQueryService {
  readonly #state: NotificationStateService;
  readonly #cursor: TimeCursorService;

  constructor(state: NotificationStateService, cursor: TimeCursorService) {
    this.#state = state;
    this.#cursor = cursor;
  }

  async query(
    command: NotificationQueryCommand,
  ): Promise<NotificationQueryPage> {
    const limit = parseLimit(command.limit);
    let after: TimeCursorValue | null;
    try {
      after = this.#cursor.decode(command.after, {
        actorUserId: command.actorUserId,
        namespace: "NOTIFICATION",
        projectId: null,
      });
    } catch (error) {
      if (error instanceof TimeCursorError) {
        throw new NotificationQueryValidationError(
          "invalid-cursor",
          "cursor is invalid, expired, or bound to another user",
        );
      }
      throw error;
    }
    let hiddenRules: readonly string[];
    try {
      hiddenRules = notificationMuteRules(command.mutedProjectCategories);
    } catch (error) {
      if (error instanceof InvalidMutedProjectCategoriesError) {
        throw new NotificationQueryValidationError(
          "invalid-mute",
          error.message,
        );
      }
      throw error;
    }
    const page = await this.#state.read({
      recipientId: command.actorUserId,
      unreadOnly: command.unreadOnly === true,
      limit,
      after,
      hiddenRules,
    });
    return {
      items: page.items,
      nextCursor:
        page.last === null
          ? null
          : this.#cursor.encode({
              actorUserId: command.actorUserId,
              namespace: "NOTIFICATION",
              projectId: null,
              afterAt: page.last.at,
              afterId: page.last.id,
            }),
      hasMore: page.last !== null,
    };
  }

  async unreadCount(
    actorUserId: number,
    mutedProjectCategories?: string,
  ): Promise<number> {
    try {
      return await this.#state.countUnread(
        actorUserId,
        notificationMuteRules(mutedProjectCategories),
      );
    } catch (error) {
      if (error instanceof InvalidMutedProjectCategoriesError) {
        throw new NotificationQueryValidationError(
          "invalid-mute",
          error.message,
        );
      }
      throw error;
    }
  }
}
