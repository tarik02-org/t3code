import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
  ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  EnvironmentCacheStore,
  registerConnectionInCatalog,
  removeCatalogValue,
  removeConnectionFromCatalog,
  replaceCatalogValue,
  ThreadHistoryCacheStore,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionTransientError,
  CredentialStore,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  NonNegativeInt,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationShellSnapshot,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  ServerConfig,
  ThreadId,
  VcsListRefsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const DATABASE_NAME = "t3code:connection-runtime";
const DATABASE_VERSION = 4;
const THREAD_HISTORY_DATABASE_NAME = "t3code:tarik02-thread-history-cache";
const THREAD_HISTORY_DATABASE_VERSION = 2;
const THREAD_HISTORY_LEGACY_STORE_NAME = "thread-history";
const THREAD_HISTORY_THREAD_STORE_NAME = "thread";
const THREAD_HISTORY_MESSAGE_STORE_NAME = "message";
const THREAD_HISTORY_ACTIVITY_STORE_NAME = "activity";
const THREAD_HISTORY_PLAN_STORE_NAME = "plan";
const THREAD_HISTORY_MESSAGE_ID_INDEX_NAME = "by-message-id";
const THREAD_HISTORY_ACTIVITY_POSITION_INDEX_NAME = "by-position";
const THREAD_HISTORY_PLAN_POSITION_INDEX_NAME = "by-position";
const CATALOG_STORE_NAME = "catalog";
const SHELL_STORE_NAME = "shell";
const THREAD_STORE_NAME = "thread";
const SERVER_CONFIG_STORE_NAME = "server-config";
const VCS_REFS_STORE_NAME = "vcs-refs";
const CATALOG_KEY = "document";
const SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;
const THREAD_HISTORY_CACHE_SCHEMA_VERSION = 1;

const StoredShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot,
});
const StoredShellSnapshotJson = Schema.fromJsonString(StoredShellSnapshot);
// v2 stores the snapshot sequence alongside the thread so a warm cache can
// resume via `afterSequence` instead of re-downloading the full thread body.
// Older v1 entries (no sequence) fail to decode and are treated as a cold cache.
const StoredThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationThreadDetailSnapshot,
});
const StoredThreadSnapshotJson = Schema.fromJsonString(StoredThreadSnapshot);
const StoredThreadHistoryRange = Schema.Struct({
  startIndex: NonNegativeInt,
  endIndex: NonNegativeInt,
});
const StoredThreadHistoryThread = Schema.Struct({
  schemaVersion: Schema.Literal(THREAD_HISTORY_CACHE_SCHEMA_VERSION),
  scope: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  totalMessages: NonNegativeInt,
  ranges: Schema.Array(StoredThreadHistoryRange),
});
const StoredThreadHistoryMessage = Schema.Struct({
  schemaVersion: Schema.Literal(THREAD_HISTORY_CACHE_SCHEMA_VERSION),
  scope: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  index: NonNegativeInt,
  messageId: OrchestrationMessage.fields.id,
  message: OrchestrationMessage,
});
const StoredThreadHistoryActivity = Schema.Struct({
  schemaVersion: Schema.Literal(THREAD_HISTORY_CACHE_SCHEMA_VERSION),
  scope: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  position: NonNegativeInt,
  activityId: OrchestrationThreadActivity.fields.id,
  activity: OrchestrationThreadActivity,
});
const StoredThreadHistoryPlan = Schema.Struct({
  schemaVersion: Schema.Literal(THREAD_HISTORY_CACHE_SCHEMA_VERSION),
  scope: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  position: NonNegativeInt,
  planId: OrchestrationProposedPlan.fields.id,
  plan: OrchestrationProposedPlan,
});
const StoredServerConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  config: ServerConfig,
});
const StoredServerConfigJson = Schema.fromJsonString(StoredServerConfig);
const StoredVcsRefs = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  cwd: Schema.String,
  refs: VcsListRefsResult,
});
const StoredVcsRefsJson = Schema.fromJsonString(StoredVcsRefs);
const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocumentJson);
const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredShellSnapshotJson);
const encodeStoredShellSnapshot = Schema.encodeEffect(StoredShellSnapshotJson);
const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(StoredThreadSnapshotJson);
const encodeStoredThreadSnapshot = Schema.encodeEffect(StoredThreadSnapshotJson);
const decodeStoredThreadHistoryThread = Schema.decodeUnknownEffect(StoredThreadHistoryThread);
const decodeStoredThreadHistoryMessage = Schema.decodeUnknownEffect(StoredThreadHistoryMessage);
const decodeStoredThreadHistoryMessages = (values: ReadonlyArray<unknown>) =>
  Effect.forEach(values, (value) => decodeStoredThreadHistoryMessage(value), {
    concurrency: "unbounded",
  });
const decodeStoredThreadHistoryActivity = Schema.decodeUnknownEffect(StoredThreadHistoryActivity);
const decodeStoredThreadHistoryActivities = (values: ReadonlyArray<unknown>) =>
  Effect.forEach(values, (value) => decodeStoredThreadHistoryActivity(value), {
    concurrency: "unbounded",
  });
const decodeStoredThreadHistoryPlan = Schema.decodeUnknownEffect(StoredThreadHistoryPlan);
const decodeStoredThreadHistoryPlans = (values: ReadonlyArray<unknown>) =>
  Effect.forEach(values, (value) => decodeStoredThreadHistoryPlan(value), {
    concurrency: "unbounded",
  });
const decodeStoredServerConfig = Schema.decodeUnknownEffect(StoredServerConfigJson);
const encodeStoredServerConfig = Schema.encodeEffect(StoredServerConfigJson);
const decodeStoredVcsRefs = Schema.decodeUnknownEffect(StoredVcsRefsJson);
const encodeStoredVcsRefs = Schema.encodeEffect(StoredVcsRefsJson);

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

function persistenceError(
  operation:
    | "list-targets"
    | "register-connection"
    | "remove-connection"
    | "load-shell"
    | "save-shell"
    | "load-thread"
    | "save-thread"
    | "remove-thread"
    | "load-thread-history"
    | "save-thread-history"
    | "load-server-config"
    | "save-server-config"
    | "load-vcs-refs"
    | "save-vcs-refs"
    | "clear-environment",
  cause: unknown,
) {
  return new ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

const openDatabase = Effect.fn("web.connectionStorage.openDatabase")(function* () {
  return yield* Effect.callback<IDBDatabase, ConnectionTransientError>((resume) => {
    if (typeof indexedDB === "undefined") {
      resume(
        Effect.fail(catalogError("open", "IndexedDB is unavailable in this browser context.")),
      );
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(CATALOG_STORE_NAME)) {
        request.result.createObjectStore(CATALOG_STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(SHELL_STORE_NAME)) {
        request.result.createObjectStore(SHELL_STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(THREAD_STORE_NAME)) {
        request.result.createObjectStore(THREAD_STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(SERVER_CONFIG_STORE_NAME)) {
        request.result.createObjectStore(SERVER_CONFIG_STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(VCS_REFS_STORE_NAME)) {
        request.result.createObjectStore(VCS_REFS_STORE_NAME);
      }
    });
    request.addEventListener("error", () => {
      resume(Effect.fail(catalogError("open", request.error ?? "Unknown IndexedDB error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  });
});

const openThreadHistoryDatabase = Effect.fn("web.connectionStorage.openThreadHistoryDatabase")(
  function* () {
    return yield* Effect.callback<IDBDatabase, ConnectionTransientError>((resume) => {
      if (globalThis.indexedDB === undefined) {
        resume(
          Effect.fail(catalogError("open", "IndexedDB is unavailable in this browser context.")),
        );
        return;
      }
      const request = indexedDB.open(THREAD_HISTORY_DATABASE_NAME, THREAD_HISTORY_DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        if (request.result.objectStoreNames.contains(THREAD_HISTORY_LEGACY_STORE_NAME)) {
          request.result.deleteObjectStore(THREAD_HISTORY_LEGACY_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(THREAD_HISTORY_THREAD_STORE_NAME)) {
          request.result.createObjectStore(THREAD_HISTORY_THREAD_STORE_NAME, {
            keyPath: "scope",
          });
        }
        if (!request.result.objectStoreNames.contains(THREAD_HISTORY_MESSAGE_STORE_NAME)) {
          const store = request.result.createObjectStore(THREAD_HISTORY_MESSAGE_STORE_NAME, {
            keyPath: ["scope", "index"],
          });
          store.createIndex(THREAD_HISTORY_MESSAGE_ID_INDEX_NAME, ["scope", "messageId"], {
            unique: true,
          });
        }
        if (!request.result.objectStoreNames.contains(THREAD_HISTORY_ACTIVITY_STORE_NAME)) {
          const store = request.result.createObjectStore(THREAD_HISTORY_ACTIVITY_STORE_NAME, {
            keyPath: ["scope", "activityId"],
          });
          store.createIndex(
            THREAD_HISTORY_ACTIVITY_POSITION_INDEX_NAME,
            ["scope", "position", "activity.createdAt", "activityId"],
            { unique: true },
          );
        }
        if (!request.result.objectStoreNames.contains(THREAD_HISTORY_PLAN_STORE_NAME)) {
          const store = request.result.createObjectStore(THREAD_HISTORY_PLAN_STORE_NAME, {
            keyPath: ["scope", "planId"],
          });
          store.createIndex(
            THREAD_HISTORY_PLAN_POSITION_INDEX_NAME,
            ["scope", "position", "plan.createdAt", "planId"],
            { unique: true },
          );
        }
      });
      request.addEventListener("error", () => {
        resume(
          Effect.fail(
            catalogError("open thread history cache", request.error ?? "Unknown IndexedDB error"),
          ),
        );
      });
      request.addEventListener("success", () => {
        resume(Effect.succeed(request.result));
      });
    });
  },
);

function readDatabaseValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<unknown, ConnectionTransientError>((resume) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.addEventListener("error", () => {
      resume(Effect.fail(catalogError("read", request.error ?? "Unknown IndexedDB read error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  }).pipe(Effect.withSpan("web.connectionStorage.readDatabaseValue"));
}

function readDatabaseValuesInRange(
  database: IDBDatabase,
  storeName: string,
  range: IDBKeyRange,
  indexName?: string,
) {
  return Effect.callback<ReadonlyArray<unknown>, ConnectionTransientError>((resume) => {
    const store = database.transaction(storeName, "readonly").objectStore(storeName);
    const request = (indexName === undefined ? store : store.index(indexName)).getAll(range);
    request.addEventListener("error", () => {
      resume(Effect.fail(catalogError("read", request.error ?? "Unknown IndexedDB read error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  }).pipe(Effect.withSpan("web.connectionStorage.readDatabaseValuesInRange"));
}

function writeDatabaseValue(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("write", transaction.error ?? "Unknown IndexedDB write error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(storeName).put(value, key);
  }).pipe(Effect.withSpan("web.connectionStorage.writeDatabaseValue"));
}

function writeThreadHistoryPage(
  database: IDBDatabase,
  thread: object,
  messages: ReadonlyArray<object>,
  activities: ReadonlyArray<object>,
  plans: ReadonlyArray<object>,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(
      [
        THREAD_HISTORY_THREAD_STORE_NAME,
        THREAD_HISTORY_MESSAGE_STORE_NAME,
        THREAD_HISTORY_ACTIVITY_STORE_NAME,
        THREAD_HISTORY_PLAN_STORE_NAME,
      ],
      "readwrite",
    );
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("write", transaction.error ?? "Unknown IndexedDB write error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(THREAD_HISTORY_THREAD_STORE_NAME).put(thread);
    const messageStore = transaction.objectStore(THREAD_HISTORY_MESSAGE_STORE_NAME);
    for (const message of messages) {
      messageStore.put(message);
    }
    const activityStore = transaction.objectStore(THREAD_HISTORY_ACTIVITY_STORE_NAME);
    for (const activity of activities) {
      activityStore.put(activity);
    }
    const planStore = transaction.objectStore(THREAD_HISTORY_PLAN_STORE_NAME);
    for (const plan of plans) {
      planStore.put(plan);
    }
  }).pipe(Effect.withSpan("web.connectionStorage.writeThreadHistoryPage"));
}

function removeDatabaseValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("remove", transaction.error ?? "Unknown IndexedDB remove error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(storeName).delete(key);
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValue"));
}

function removeDatabaseValuesInRange(database: IDBDatabase, storeName: string, range: IDBKeyRange) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("remove", transaction.error ?? "Unknown IndexedDB cursor error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    const request = transaction.objectStore(storeName).openCursor(range);
    request.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("remove", request.error ?? "Unknown IndexedDB cursor error")),
      );
    });
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        return;
      }
      cursor.delete();
      cursor.continue();
    });
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValuesInRange"));
}

function threadCacheKey(environmentId: EnvironmentId, threadId: ThreadId) {
  return `${environmentId}:${threadId}`;
}

function threadHistoryScope(environmentId: EnvironmentId, threadId: ThreadId) {
  return `${environmentId}:${threadId}`;
}

const loadThreadHistoryThread = Effect.fn("web.connectionStorage.loadThreadHistoryThread")(
  function* (database: IDBDatabase, environmentId: EnvironmentId, threadId: ThreadId) {
    const scope = threadHistoryScope(environmentId, threadId);
    const raw = yield* readDatabaseValue(database, THREAD_HISTORY_THREAD_STORE_NAME, scope);
    if (raw === undefined) {
      return Option.none();
    }
    const thread = yield* decodeStoredThreadHistoryThread(raw);
    return thread.scope === scope &&
      thread.environmentId === environmentId &&
      thread.threadId === threadId
      ? Option.some(thread)
      : Option.none();
  },
);

const loadThreadHistoryPage = Effect.fn("web.connectionStorage.loadThreadHistoryPage")(function* (
  database: IDBDatabase,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  startIndex: number,
  endIndex: number,
  totalMessages: number,
) {
  if (endIndex <= startIndex) {
    return Option.none();
  }
  const scope = threadHistoryScope(environmentId, threadId);
  const [rawMessages, rawActivities, rawPlans] = yield* Effect.all([
    readDatabaseValuesInRange(
      database,
      THREAD_HISTORY_MESSAGE_STORE_NAME,
      IDBKeyRange.bound([scope, startIndex], [scope, endIndex - 1]),
    ),
    readDatabaseValuesInRange(
      database,
      THREAD_HISTORY_ACTIVITY_STORE_NAME,
      IDBKeyRange.bound([scope, startIndex], [scope, endIndex, "\uffff", "\uffff"]),
      THREAD_HISTORY_ACTIVITY_POSITION_INDEX_NAME,
    ),
    readDatabaseValuesInRange(
      database,
      THREAD_HISTORY_PLAN_STORE_NAME,
      IDBKeyRange.bound([scope, startIndex], [scope, endIndex, "\uffff", "\uffff"]),
      THREAD_HISTORY_PLAN_POSITION_INDEX_NAME,
    ),
  ]);
  const messageRecords = yield* decodeStoredThreadHistoryMessages(rawMessages);
  const activityRecords = yield* decodeStoredThreadHistoryActivities(rawActivities);
  const planRecords = yield* decodeStoredThreadHistoryPlans(rawPlans);
  if (
    messageRecords.length !== endIndex - startIndex ||
    messageRecords.some(
      (record, offset) =>
        record.scope !== scope ||
        record.environmentId !== environmentId ||
        record.threadId !== threadId ||
        record.index !== startIndex + offset,
    )
  ) {
    return Option.none();
  }
  const messages = messageRecords.map((record) => record.message);
  const firstMessage = messages[0];
  if (firstMessage === undefined) {
    return Option.none();
  }
  return Option.some({
    messages,
    activities: activityRecords
      .filter(
        (record) =>
          record.scope === scope &&
          record.environmentId === environmentId &&
          record.threadId === threadId,
      )
      .map((record) => record.activity)
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    proposedPlans: planRecords
      .filter(
        (record) =>
          record.scope === scope &&
          record.environmentId === environmentId &&
          record.threadId === threadId,
      )
      .map((record) => record.plan)
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    messageHistory: {
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: endIndex < totalMessages,
      startIndex,
      endIndex,
      totalMessages,
      cursor: {
        createdAt: firstMessage.createdAt,
        messageId: firstMessage.id,
      },
    },
  });
});

function vcsRefsCacheKey(environmentId: EnvironmentId, cwd: string) {
  return `${environmentId}:${cwd}`;
}

const decodeCatalog = Effect.fn("web.connectionStorage.decodeCatalog")(function* (raw: string) {
  return yield* decodeConnectionCatalogDocument(raw).pipe(
    Effect.mapError((cause) => catalogError("decode", cause)),
  );
});

const encodeCatalog = Effect.fn("web.connectionStorage.encodeCatalog")(function* (
  catalog: ConnectionCatalogDocumentType,
) {
  return yield* encodeConnectionCatalogDocument(catalog).pipe(
    Effect.mapError((cause) => catalogError("encode", cause)),
  );
});

export interface CatalogBackend {
  readonly read: Effect.Effect<string | null, ConnectionTransientError>;
  readonly write: (raw: string) => Effect.Effect<void, ConnectionTransientError>;
  readonly quarantine?: (raw: string) => Effect.Effect<void, ConnectionTransientError>;
}

export function makeCatalogBackend(database: IDBDatabase): CatalogBackend {
  const bridge = window.desktopBridge;
  if (bridge?.getConnectionCatalog !== undefined && bridge.setConnectionCatalog !== undefined) {
    return {
      read: Effect.tryPromise({
        try: () => bridge.getConnectionCatalog!(),
        catch: (cause) => catalogError("load", cause),
      }),
      write: (raw) =>
        Effect.tryPromise({
          try: () => bridge.setConnectionCatalog!(raw),
          catch: (cause) => catalogError("save", cause),
        }).pipe(
          Effect.flatMap((stored) =>
            stored
              ? Effect.void
              : Effect.fail(
                  catalogError(
                    "save",
                    "Desktop secure storage is unavailable in this system context.",
                  ),
                ),
          ),
        ),
    };
  }

  return {
    read: readDatabaseValue(database, CATALOG_STORE_NAME, CATALOG_KEY).pipe(
      Effect.map((value) => (typeof value === "string" ? value : null)),
    ),
    write: (raw) => writeDatabaseValue(database, CATALOG_STORE_NAME, CATALOG_KEY, raw),
    quarantine: (raw) =>
      writeDatabaseValue(database, CATALOG_STORE_NAME, `${CATALOG_KEY}:corrupt:${Date.now()}`, raw),
  };
}

interface CatalogStore {
  readonly read: Effect.Effect<ConnectionCatalogDocumentType, ConnectionTransientError>;
  readonly update: (
    transform: (catalog: ConnectionCatalogDocumentType) => ConnectionCatalogDocumentType,
  ) => Effect.Effect<void, ConnectionTransientError>;
}

export const makeCatalogStore = Effect.fn("web.connectionStorage.makeCatalogStore")(function* (
  backend: CatalogBackend,
) {
  const state = yield* Ref.make<Option.Option<ConnectionCatalogDocumentType>>(Option.none());
  const lock = yield* Semaphore.make(1);

  const loadUnlocked = Effect.fn("web.connectionStorage.loadCatalog")(function* () {
    const cached = yield* Ref.get(state);
    if (Option.isSome(cached)) {
      return cached.value;
    }
    const raw = yield* backend.read;
    let catalog = EMPTY_CONNECTION_CATALOG_DOCUMENT;
    if (raw !== null && raw.trim() !== "") {
      catalog = yield* decodeCatalog(raw).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Discarding a corrupt web connection catalog.", {
              error: error.message,
            });
            if (backend.quarantine !== undefined) {
              yield* backend.quarantine(raw).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Could not quarantine the corrupt web connection catalog.", {
                    error: cause.message,
                  }),
                ),
              );
            }
            const encoded = yield* encodeCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT);
            yield* backend.write(encoded).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not persist the recovered web connection catalog.", {
                  error: cause.message,
                }),
              ),
            );
            return EMPTY_CONNECTION_CATALOG_DOCUMENT;
          }),
        ),
      );
    }
    yield* Ref.set(state, Option.some(catalog));
    return catalog;
  });

  const read = lock.withPermits(1)(loadUnlocked());
  const update: CatalogStore["update"] = Effect.fn("web.connectionStorage.updateCatalog")(
    function* (transform) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const next = transform(yield* loadUnlocked());
          yield* backend.write(yield* encodeCatalog(next));
          yield* Ref.set(state, Option.some(next));
        }),
      );
    },
  );

  return { read, update } satisfies CatalogStore;
});

export const connectionStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(openDatabase(), (database) =>
      Effect.sync(() => database.close()),
    );
    const threadHistoryDatabase = yield* Effect.acquireRelease(
      openThreadHistoryDatabase(),
      (database) => Effect.sync(() => database.close()),
    );
    const threadHistoryWriteLock = yield* Semaphore.make(1);
    const catalog = yield* makeCatalogStore(makeCatalogBackend(database));

    const targetStore = ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError((cause) => persistenceError("list-targets", cause)),
      ),
    });
    const registrationStore = ConnectionRegistrationStore.of({
      register: (registration) =>
        catalog
          .update((document) => registerConnectionInCatalog(document, registration))
          .pipe(Effect.mapError((cause) => persistenceError("register-connection", cause))),
      remove: (target) =>
        catalog
          .update((document) => removeConnectionFromCatalog(document, target))
          .pipe(Effect.mapError((cause) => persistenceError("remove-connection", cause))),
    });
    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.profiles.find((profile) => profile.connectionId === connectionId),
            ),
          ),
        ),
      put: (profile) =>
        catalog.update((document) => ({
          ...document,
          profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, profile),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
            ),
          ),
        ),
      put: (connectionId, credential) =>
        catalog.update((document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const remoteTokenStore = TokenStore.make({
      get: (environmentId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.remoteDpopTokens.find((token) => token.environmentId === environmentId),
            ),
          ),
        ),
      put: (token) =>
        catalog.update((document) => ({
          ...document,
          remoteDpopTokens: replaceCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            token,
          ),
        })),
      remove: (environmentId) =>
        catalog.update((document) => ({
          ...document,
          remoteDpopTokens: removeCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            environmentId,
          ),
        })),
    });
    const cacheStore = EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        readDatabaseValue(database, SHELL_STORE_NAME, environmentId).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }
            return decodeStoredShellSnapshot(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-shell", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId
                  ? Option.some(stored.snapshot)
                  : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-shell", cause),
          ),
        ),
      saveShell: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredShellSnapshot({
            schemaVersion: SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION,
            environmentId,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-shell", cause)));
          yield* writeDatabaseValue(database, SHELL_STORE_NAME, environmentId, encoded);
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-shell", cause),
          ),
        ),
      loadServerConfig: (environmentId) =>
        readDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }
            return decodeStoredServerConfig(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-server-config", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId ? Option.some(stored.config) : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-server-config", cause),
          ),
        ),
      saveServerConfig: (environmentId, config) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredServerConfig({
            schemaVersion: 1,
            environmentId,
            config,
          }).pipe(Effect.mapError((cause) => persistenceError("save-server-config", cause)));
          yield* writeDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId, encoded);
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-server-config", cause),
          ),
        ),
      loadThread: (environmentId, threadId) =>
        readDatabaseValue(
          database,
          THREAD_STORE_NAME,
          threadCacheKey(environmentId, threadId),
        ).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }
            return decodeStoredThreadSnapshot(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-thread", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId && stored.threadId === threadId
                  ? Option.some(stored.snapshot)
                  : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-thread", cause),
          ),
        ),
      saveThread: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredThreadSnapshot({
            schemaVersion: 2,
            environmentId,
            threadId: snapshot.thread.id,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-thread", cause)));
          yield* writeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, snapshot.thread.id),
            encoded,
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-thread", cause),
          ),
        ),
      loadVcsRefs: (environmentId, cwd) =>
        readDatabaseValue(database, VCS_REFS_STORE_NAME, vcsRefsCacheKey(environmentId, cwd)).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }
            return decodeStoredVcsRefs(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-vcs-refs", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId && stored.cwd === cwd
                  ? Option.some(stored.refs)
                  : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-vcs-refs", cause),
          ),
        ),
      saveVcsRefs: (environmentId, cwd, refs) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredVcsRefs({
            schemaVersion: 1,
            environmentId,
            cwd,
            refs,
          }).pipe(Effect.mapError((cause) => persistenceError("save-vcs-refs", cause)));
          yield* writeDatabaseValue(
            database,
            VCS_REFS_STORE_NAME,
            vcsRefsCacheKey(environmentId, cwd),
            encoded,
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-vcs-refs", cause),
          ),
        ),
      removeThread: (environmentId, threadId) =>
        removeDatabaseValue(
          database,
          THREAD_STORE_NAME,
          threadCacheKey(environmentId, threadId),
        ).pipe(Effect.mapError((cause) => persistenceError("remove-thread", cause))),
      clear: (environmentId) =>
        Effect.all(
          [
            removeDatabaseValue(database, SHELL_STORE_NAME, environmentId),
            removeDatabaseValuesInRange(
              database,
              THREAD_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
            removeDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId),
            removeDatabaseValuesInRange(
              database,
              VCS_REFS_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_THREAD_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_MESSAGE_STORE_NAME,
              IDBKeyRange.bound([`${environmentId}:`], [`${environmentId}:\uffff`]),
            ),
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_ACTIVITY_STORE_NAME,
              IDBKeyRange.bound([`${environmentId}:`], [`${environmentId}:\uffff`]),
            ),
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_PLAN_STORE_NAME,
              IDBKeyRange.bound([`${environmentId}:`], [`${environmentId}:\uffff`]),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.mapError((cause) => persistenceError("clear-environment", cause))),
    });
    const threadHistoryCacheStore = ThreadHistoryCacheStore.of({
      loadPrevious: (environmentId, threadId, endIndex, limit) =>
        Effect.gen(function* () {
          const thread = yield* loadThreadHistoryThread(
            threadHistoryDatabase,
            environmentId,
            threadId,
          );
          if (Option.isNone(thread)) {
            return { page: Option.none(), requestLimit: limit };
          }
          const range = thread.value.ranges.find(
            (candidate) => candidate.startIndex < endIndex && candidate.endIndex >= endIndex,
          );
          if (range !== undefined) {
            return {
              page: yield* loadThreadHistoryPage(
                threadHistoryDatabase,
                environmentId,
                threadId,
                Math.max(range.startIndex, endIndex - limit),
                endIndex,
                thread.value.totalMessages,
              ),
              requestLimit: limit,
            };
          }
          const nearestRange = thread.value.ranges.findLast(
            (candidate) => candidate.endIndex < endIndex,
          );
          return {
            page: Option.none(),
            requestLimit: Math.min(
              limit,
              endIndex - (nearestRange?.endIndex ?? Math.max(0, endIndex - limit)),
            ),
          };
        }).pipe(Effect.mapError((cause) => persistenceError("load-thread-history", cause))),
      loadNext: (environmentId, threadId, startIndex, limit) =>
        Effect.gen(function* () {
          const thread = yield* loadThreadHistoryThread(
            threadHistoryDatabase,
            environmentId,
            threadId,
          );
          if (Option.isNone(thread)) {
            return { page: Option.none(), requestLimit: limit };
          }
          const range = thread.value.ranges.find(
            (candidate) => candidate.startIndex <= startIndex && candidate.endIndex > startIndex,
          );
          if (range !== undefined) {
            return {
              page: yield* loadThreadHistoryPage(
                threadHistoryDatabase,
                environmentId,
                threadId,
                startIndex,
                Math.min(range.endIndex, startIndex + limit),
                thread.value.totalMessages,
              ),
              requestLimit: limit,
            };
          }
          const nearestRange = thread.value.ranges.find(
            (candidate) => candidate.startIndex > startIndex,
          );
          return {
            page: Option.none(),
            requestLimit: Math.min(
              limit,
              (nearestRange?.startIndex ?? startIndex + limit) - startIndex,
            ),
          };
        }).pipe(Effect.mapError((cause) => persistenceError("load-thread-history", cause))),
      loadAround: (environmentId, threadId, messageId, limit) =>
        Effect.gen(function* () {
          const scope = threadHistoryScope(environmentId, threadId);
          const [thread, rawTargets] = yield* Effect.all([
            loadThreadHistoryThread(threadHistoryDatabase, environmentId, threadId),
            readDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_MESSAGE_STORE_NAME,
              IDBKeyRange.only([scope, messageId]),
              THREAD_HISTORY_MESSAGE_ID_INDEX_NAME,
            ),
          ]);
          const targets = yield* decodeStoredThreadHistoryMessages(rawTargets);
          const target = targets[0];
          if (
            Option.isNone(thread) ||
            target === undefined ||
            target.scope !== scope ||
            target.environmentId !== environmentId ||
            target.threadId !== threadId
          ) {
            return Option.none();
          }
          const range = thread.value.ranges.find(
            (candidate) =>
              candidate.startIndex <= target.index && candidate.endIndex > target.index,
          );
          if (range === undefined) {
            return Option.none();
          }
          let startIndex = Math.max(range.startIndex, target.index - Math.floor((limit - 1) / 2));
          const endIndex = Math.min(range.endIndex, startIndex + limit);
          startIndex = Math.max(range.startIndex, endIndex - limit);
          return yield* loadThreadHistoryPage(
            threadHistoryDatabase,
            environmentId,
            threadId,
            startIndex,
            endIndex,
            thread.value.totalMessages,
          );
        }).pipe(Effect.mapError((cause) => persistenceError("load-thread-history", cause))),
      loadTotalMessages: (environmentId, threadId) =>
        loadThreadHistoryThread(threadHistoryDatabase, environmentId, threadId).pipe(
          Effect.map(Option.map((thread) => thread.totalMessages)),
          Effect.mapError((cause) => persistenceError("load-thread-history", cause)),
        ),
      save: (environmentId, threadId, page) =>
        threadHistoryWriteLock
          .withPermits(1)(
            Effect.gen(function* () {
              if (page.messages.length === 0) {
                return;
              }
              const scope = threadHistoryScope(environmentId, threadId);
              const current = yield* loadThreadHistoryThread(
                threadHistoryDatabase,
                environmentId,
                threadId,
              );
              const ranges = [
                ...(Option.isSome(current) ? current.value.ranges : []),
                {
                  startIndex: page.messageHistory.startIndex,
                  endIndex: page.messageHistory.endIndex,
                },
              ].toSorted((left, right) => left.startIndex - right.startIndex);
              const mergedRanges: Array<{ readonly startIndex: number; endIndex: number }> = [];
              for (const range of ranges) {
                const previous = mergedRanges.at(-1);
                if (previous === undefined || previous.endIndex < range.startIndex) {
                  mergedRanges.push({ ...range });
                } else {
                  previous.endIndex = Math.max(previous.endIndex, range.endIndex);
                }
              }
              let activityMessageOffset = 0;
              const activities = page.activities.map((activity) => {
                while (
                  activityMessageOffset < page.messages.length &&
                  page.messages[activityMessageOffset]!.createdAt <= activity.createdAt
                ) {
                  activityMessageOffset += 1;
                }
                return {
                  schemaVersion: THREAD_HISTORY_CACHE_SCHEMA_VERSION,
                  scope,
                  environmentId,
                  threadId,
                  position: page.messageHistory.startIndex + activityMessageOffset,
                  activityId: activity.id,
                  activity,
                };
              });
              let planMessageOffset = 0;
              const plans = page.proposedPlans.map((plan) => {
                while (
                  planMessageOffset < page.messages.length &&
                  page.messages[planMessageOffset]!.createdAt <= plan.createdAt
                ) {
                  planMessageOffset += 1;
                }
                return {
                  schemaVersion: THREAD_HISTORY_CACHE_SCHEMA_VERSION,
                  scope,
                  environmentId,
                  threadId,
                  position: page.messageHistory.startIndex + planMessageOffset,
                  planId: plan.id,
                  plan,
                };
              });
              yield* writeThreadHistoryPage(
                threadHistoryDatabase,
                {
                  schemaVersion: THREAD_HISTORY_CACHE_SCHEMA_VERSION,
                  scope,
                  environmentId,
                  threadId,
                  totalMessages: Math.max(
                    Option.isSome(current) ? current.value.totalMessages : 0,
                    page.messageHistory.totalMessages,
                  ),
                  ranges: mergedRanges,
                },
                page.messages.map((message, offset) => ({
                  schemaVersion: THREAD_HISTORY_CACHE_SCHEMA_VERSION,
                  scope,
                  environmentId,
                  threadId,
                  index: page.messageHistory.startIndex + offset,
                  messageId: message.id,
                  message,
                })),
                activities,
                plans,
              );
            }),
          )
          .pipe(Effect.mapError((cause) => persistenceError("save-thread-history", cause))),
      remove: (environmentId, threadId) =>
        Effect.all(
          [
            removeDatabaseValue(
              threadHistoryDatabase,
              THREAD_HISTORY_THREAD_STORE_NAME,
              threadHistoryScope(environmentId, threadId),
            ),
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_MESSAGE_STORE_NAME,
              IDBKeyRange.bound(
                [threadHistoryScope(environmentId, threadId), 0],
                [threadHistoryScope(environmentId, threadId), Number.MAX_SAFE_INTEGER],
              ),
            ),
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_ACTIVITY_STORE_NAME,
              IDBKeyRange.bound(
                [threadHistoryScope(environmentId, threadId)],
                [threadHistoryScope(environmentId, threadId), "\uffff"],
              ),
            ),
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_PLAN_STORE_NAME,
              IDBKeyRange.bound(
                [threadHistoryScope(environmentId, threadId)],
                [threadHistoryScope(environmentId, threadId), "\uffff"],
              ),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.mapError((cause) => persistenceError("remove-thread", cause))),
      clear: (environmentId) =>
        Effect.all(
          [
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_THREAD_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_MESSAGE_STORE_NAME,
              IDBKeyRange.bound([`${environmentId}:`], [`${environmentId}:\uffff`]),
            ),
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_ACTIVITY_STORE_NAME,
              IDBKeyRange.bound([`${environmentId}:`], [`${environmentId}:\uffff`]),
            ),
            removeDatabaseValuesInRange(
              threadHistoryDatabase,
              THREAD_HISTORY_PLAN_STORE_NAME,
              IDBKeyRange.bound([`${environmentId}:`], [`${environmentId}:\uffff`]),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.mapError((cause) => persistenceError("clear-environment", cause))),
    });

    return Context.make(ConnectionTargetStore, targetStore).pipe(
      Context.add(ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
      Context.add(EnvironmentCacheStore, cacheStore),
      Context.add(ThreadHistoryCacheStore, threadHistoryCacheStore),
    );
  }),
);
