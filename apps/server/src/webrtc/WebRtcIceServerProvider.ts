import type { WebRtcIceServer } from "@t3tools/websocket-webrtc/peer";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const CLOUDFLARE_TURN_API_BASE_URL = "https://rtc.live.cloudflare.com/v1/turn/keys";
const CLOUDFLARE_TURN_CREDENTIAL_TTL_SECONDS = 48 * 60 * 60;
const DEFAULT_STUN_URLS = ["stun:stun.cloudflare.com:3478"];

const StunUrl = Schema.Trim.check(Schema.isPattern(/^stuns?:/u), Schema.isLengthBetween(1, 2_048));
const TurnUrl = Schema.Trim.check(Schema.isPattern(/^turns?:/u), Schema.isLengthBetween(1, 2_048));
const IceCredential = Schema.Trim.check(Schema.isLengthBetween(1, 512));
const CloudflareTurnKeyId = Schema.Trim.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
  Schema.isLengthBetween(1, 512),
);
const RedactedIceCredential = Schema.Redacted(IceCredential);

const WebRtcIceServerEnvConfig = Config.all({
  stunUrls: Config.schema(Config.Array(StunUrl), "T3CODE_WEBRTC_STUN_URLS").pipe(
    Config.withDefault(DEFAULT_STUN_URLS),
  ),
  turnUrls: Config.schema(Config.Array(TurnUrl), "T3CODE_WEBRTC_TURN_URLS").pipe(Config.option),
  turnUsername: Config.schema(IceCredential, "T3CODE_WEBRTC_TURN_USERNAME").pipe(Config.option),
  turnCredential: Config.schema(RedactedIceCredential, "T3CODE_WEBRTC_TURN_CREDENTIAL").pipe(
    Config.option,
  ),
  cloudflareTurnKeyId: Config.schema(
    CloudflareTurnKeyId,
    "T3CODE_WEBRTC_CLOUDFLARE_TURN_KEY_ID",
  ).pipe(Config.option),
  cloudflareTurnApiToken: Config.schema(
    RedactedIceCredential,
    "T3CODE_WEBRTC_CLOUDFLARE_TURN_API_TOKEN",
  ).pipe(Config.option),
});

const CloudflareTurnCredentialRequest = Schema.Struct({
  ttl: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 48 * 60 * 60 })),
});

const CloudflareIceServer = Schema.Struct({
  urls: Schema.Array(Schema.Union([StunUrl, TurnUrl])).check(Schema.isLengthBetween(1, 16)),
  username: Schema.optionalKey(IceCredential),
  credential: Schema.optionalKey(IceCredential),
});

const CloudflareTurnCredentialResponse = Schema.Struct({
  iceServers: Schema.Array(CloudflareIceServer).check(Schema.isLengthBetween(1, 32)),
});

const WebRtcIceServerConfigErrorReason = Schema.Literals([
  "turn-credentials-incomplete",
  "cloudflare-credentials-incomplete",
]);

class WebRtcIceServerConfigError extends Schema.TaggedErrorClass<WebRtcIceServerConfigError>()(
  "WebRtcIceServerConfigError",
  { reason: WebRtcIceServerConfigErrorReason },
) {
  override get message(): string {
    return `WebRTC ICE server configuration is invalid: ${this.reason}.`;
  }
}

class CloudflareTurnRequestBodyError extends Schema.TaggedErrorClass<CloudflareTurnRequestBodyError>()(
  "CloudflareTurnRequestBodyError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not encode the Cloudflare TURN credential request.";
  }
}

class CloudflareTurnRequestError extends Schema.TaggedErrorClass<CloudflareTurnRequestError>()(
  "CloudflareTurnRequestError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not send the Cloudflare TURN credential request.";
  }
}

class CloudflareTurnResponseError extends Schema.TaggedErrorClass<CloudflareTurnResponseError>()(
  "CloudflareTurnResponseError",
  { status: Schema.Int },
) {
  override get message(): string {
    return `Cloudflare TURN credential generation returned HTTP ${this.status}.`;
  }
}

class CloudflareTurnResponseDecodeError extends Schema.TaggedErrorClass<CloudflareTurnResponseDecodeError>()(
  "CloudflareTurnResponseDecodeError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Cloudflare returned an invalid TURN credential response.";
  }
}

class CloudflareTurnResponseEmptyError extends Schema.TaggedErrorClass<CloudflareTurnResponseEmptyError>()(
  "CloudflareTurnResponseEmptyError",
  {},
) {
  override get message(): string {
    return "Cloudflare returned no usable TURN servers.";
  }
}

type TurnConfiguration =
  | {
      readonly kind: "explicit-authenticated";
      readonly urls: ReadonlyArray<string>;
      readonly username: string;
      readonly credential: Redacted.Redacted<string>;
    }
  | { readonly kind: "explicit-anonymous"; readonly urls: ReadonlyArray<string> }
  | {
      readonly kind: "cloudflare";
      readonly keyId: string;
      readonly apiToken: Redacted.Redacted<string>;
    }
  | { readonly kind: "none" };

const generateCloudflareTurnServers = Effect.fn(
  "WebRtcIceServerProvider.generateCloudflareTurnServers",
)(function* (input: {
  readonly configuration: Extract<TurnConfiguration, { readonly kind: "cloudflare" }>;
  readonly httpClient: HttpClient.HttpClient;
}) {
  const request = yield* HttpClientRequest.post(
    `${CLOUDFLARE_TURN_API_BASE_URL}/${input.configuration.keyId}/credentials/generate-ice-servers`,
  ).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(Redacted.value(input.configuration.apiToken)),
    HttpClientRequest.schemaBodyJson(CloudflareTurnCredentialRequest)({
      ttl: CLOUDFLARE_TURN_CREDENTIAL_TTL_SECONDS,
    }),
    Effect.mapError((cause) => new CloudflareTurnRequestBodyError({ cause })),
  );
  const response = yield* input.httpClient
    .execute(request)
    .pipe(Effect.mapError((cause) => new CloudflareTurnRequestError({ cause })));
  if (response.status !== 201) {
    return yield* new CloudflareTurnResponseError({ status: response.status });
  }
  const decoded = yield* HttpClientResponse.schemaBodyJson(CloudflareTurnCredentialResponse)(
    response,
  ).pipe(Effect.mapError((cause) => new CloudflareTurnResponseDecodeError({ cause })));
  const turnServers = decoded.iceServers.flatMap((server) => {
    const urls = server.urls.filter((url) => /^turns?:/u.test(url) && !/:53(?:\?|$)/u.test(url));
    if (urls.length === 0 || server.username === undefined || server.credential === undefined) {
      return [];
    }
    return [
      {
        urls,
        username: server.username,
        credential: server.credential,
      } satisfies WebRtcIceServer,
    ];
  });
  if (turnServers.length === 0) {
    return yield* new CloudflareTurnResponseEmptyError();
  }
  return turnServers;
});

export class WebRtcIceServerProvider extends Context.Service<
  WebRtcIceServerProvider,
  {
    readonly getIceServers: Effect.Effect<ReadonlyArray<WebRtcIceServer>>;
  }
>()("t3/webrtc/WebRtcIceServerProvider") {}

export const makeWebRtcIceServerProvider = Effect.fn("makeWebRtcIceServerProvider")(function* () {
  const config = yield* WebRtcIceServerEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const turnUrls = Option.getOrElse(config.turnUrls, () => []);
  const turnUsername = Option.getOrUndefined(config.turnUsername);
  const turnCredential = Option.getOrUndefined(config.turnCredential);
  const cloudflareTurnKeyId = Option.getOrUndefined(config.cloudflareTurnKeyId);
  const cloudflareTurnApiToken = Option.getOrUndefined(config.cloudflareTurnApiToken);

  if ((turnUsername === undefined) !== (turnCredential === undefined)) {
    return yield* new WebRtcIceServerConfigError({ reason: "turn-credentials-incomplete" });
  }
  if ((cloudflareTurnKeyId === undefined) !== (cloudflareTurnApiToken === undefined)) {
    return yield* new WebRtcIceServerConfigError({ reason: "cloudflare-credentials-incomplete" });
  }

  const stunServers: ReadonlyArray<WebRtcIceServer> =
    config.stunUrls.length === 0 ? [] : [{ urls: config.stunUrls }];
  const turnConfiguration: TurnConfiguration =
    turnUrls.length > 0 && turnUsername !== undefined && turnCredential !== undefined
      ? {
          kind: "explicit-authenticated",
          urls: turnUrls,
          username: turnUsername,
          credential: turnCredential,
        }
      : turnUrls.length > 0
        ? { kind: "explicit-anonymous", urls: turnUrls }
        : cloudflareTurnKeyId !== undefined && cloudflareTurnApiToken !== undefined
          ? {
              kind: "cloudflare",
              keyId: cloudflareTurnKeyId,
              apiToken: cloudflareTurnApiToken,
            }
          : { kind: "none" };

  const getIceServers: WebRtcIceServerProvider["Service"]["getIceServers"] = (() => {
    switch (turnConfiguration.kind) {
      case "explicit-authenticated":
        return Effect.succeed([
          ...stunServers,
          {
            urls: turnConfiguration.urls,
            username: turnConfiguration.username,
            credential: Redacted.value(turnConfiguration.credential),
          },
        ]);
      case "explicit-anonymous":
        return Effect.succeed([...stunServers, { urls: turnConfiguration.urls }]);
      case "cloudflare":
        return generateCloudflareTurnServers({ configuration: turnConfiguration, httpClient }).pipe(
          Effect.timeoutOption("5 seconds"),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.logWarning(
                  "Cloudflare TURN credential generation timed out; using STUN only.",
                ).pipe(Effect.as(stunServers)),
              onSome: (turnServers) => Effect.succeed([...stunServers, ...turnServers]),
            }),
          ),
          Effect.catchTags({
            CloudflareTurnRequestBodyError: () =>
              Effect.logWarning(
                "Could not encode the Cloudflare TURN credential request; using STUN only.",
              ).pipe(Effect.as(stunServers)),
            CloudflareTurnRequestError: () =>
              Effect.logWarning(
                "Could not reach Cloudflare TURN credential generation; using STUN only.",
              ).pipe(Effect.as(stunServers)),
            CloudflareTurnResponseError: (error) =>
              Effect.logWarning("Cloudflare TURN credential generation failed; using STUN only.", {
                status: error.status,
              }).pipe(Effect.as(stunServers)),
            CloudflareTurnResponseDecodeError: () =>
              Effect.logWarning(
                "Cloudflare returned an invalid TURN credential response; using STUN only.",
              ).pipe(Effect.as(stunServers)),
            CloudflareTurnResponseEmptyError: () =>
              Effect.logWarning("Cloudflare returned no TURN servers; using STUN only.").pipe(
                Effect.as(stunServers),
              ),
          }),
        );
      case "none":
        return Effect.succeed(stunServers);
      default: {
        const _exhaustive: never = turnConfiguration;
        return _exhaustive;
      }
    }
  })();

  return WebRtcIceServerProvider.of({ getIceServers });
});

export const layer = Layer.effect(WebRtcIceServerProvider, makeWebRtcIceServerProvider());
