import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WebRtcIceServer = Schema.Struct({
  urls: Schema.Array(TrimmedNonEmptyString),
  username: Schema.optionalKey(TrimmedNonEmptyString),
  credential: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WebRtcIceServer = typeof WebRtcIceServer.Type;

const WebRtcRpcFastPathCapabilityCurrent = Schema.Struct({
  version: Schema.Literal(1),
  signaling: Schema.Literal("same-websocket-rpc"),
  iceServers: Schema.Array(WebRtcIceServer),
});

const WebRtcRpcFastPathCapabilityStunOnlyEncoded = Schema.Struct({
  version: Schema.Literal(1),
  signaling: Schema.Literal("same-websocket-rpc"),
  turn: Schema.Literal(false),
  stunUrls: Schema.Array(TrimmedNonEmptyString),
});

const WebRtcRpcFastPathCapabilityStunOnly = WebRtcRpcFastPathCapabilityStunOnlyEncoded.pipe(
  Schema.decodeTo(
    WebRtcRpcFastPathCapabilityCurrent,
    SchemaTransformation.transform<
      typeof WebRtcRpcFastPathCapabilityCurrent.Encoded,
      typeof WebRtcRpcFastPathCapabilityStunOnlyEncoded.Type
    >({
      decode: (capability) => ({
        version: capability.version,
        signaling: capability.signaling,
        iceServers: capability.stunUrls.length === 0 ? [] : [{ urls: capability.stunUrls }],
      }),
      encode: (capability) => ({
        version: capability.version,
        signaling: capability.signaling,
        turn: false,
        stunUrls: capability.iceServers.flatMap((server) => server.urls),
      }),
    }),
  ),
);

export const WebRtcRpcFastPathCapability = Schema.Union([
  WebRtcRpcFastPathCapabilityCurrent,
  WebRtcRpcFastPathCapabilityStunOnly,
]);
export type WebRtcRpcFastPathCapability = typeof WebRtcRpcFastPathCapability.Type;

export const WebRtcNegotiateInput = Schema.Struct({
  version: Schema.Literal(1),
  attemptId: TrimmedNonEmptyString,
  offerSdp: Schema.String,
});
export type WebRtcNegotiateInput = typeof WebRtcNegotiateInput.Type;

export const WebRtcNegotiateResult = Schema.Struct({
  version: Schema.Literal(1),
  attemptId: TrimmedNonEmptyString,
  answerSdp: Schema.String,
  bindingToken: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type WebRtcNegotiateResult = typeof WebRtcNegotiateResult.Type;

export const WebRtcAbortInput = Schema.Struct({
  attemptId: TrimmedNonEmptyString,
});
export type WebRtcAbortInput = typeof WebRtcAbortInput.Type;

export const WebRtcAbortResult = Schema.Struct({});
export type WebRtcAbortResult = typeof WebRtcAbortResult.Type;

export const WebRtcBindingFrame = Schema.Struct({
  version: Schema.Literal(1),
  attemptId: TrimmedNonEmptyString,
  bindingToken: TrimmedNonEmptyString,
});
export type WebRtcBindingFrame = typeof WebRtcBindingFrame.Type;

export class WebRtcFastPathDisabledError extends Schema.TaggedErrorClass<WebRtcFastPathDisabledError>()(
  "WebRtcFastPathDisabledError",
  { message: TrimmedNonEmptyString },
) {}

export class WebRtcFastPathUnsupportedError extends Schema.TaggedErrorClass<WebRtcFastPathUnsupportedError>()(
  "WebRtcFastPathUnsupportedError",
  { message: TrimmedNonEmptyString },
) {}

export class WebRtcFastPathBusyError extends Schema.TaggedErrorClass<WebRtcFastPathBusyError>()(
  "WebRtcFastPathBusyError",
  { message: TrimmedNonEmptyString },
) {}

export class WebRtcFastPathInvalidAttemptError extends Schema.TaggedErrorClass<WebRtcFastPathInvalidAttemptError>()(
  "WebRtcFastPathInvalidAttemptError",
  { message: TrimmedNonEmptyString, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export class WebRtcFastPathInvalidSdpError extends Schema.TaggedErrorClass<WebRtcFastPathInvalidSdpError>()(
  "WebRtcFastPathInvalidSdpError",
  { message: TrimmedNonEmptyString, cause: Schema.Defect() },
) {}

export class WebRtcFastPathNegotiationError extends Schema.TaggedErrorClass<WebRtcFastPathNegotiationError>()(
  "WebRtcFastPathNegotiationError",
  { message: TrimmedNonEmptyString, cause: Schema.Defect() },
) {}

export const WebRtcSignalingError = Schema.Union([
  WebRtcFastPathDisabledError,
  WebRtcFastPathUnsupportedError,
  WebRtcFastPathBusyError,
  WebRtcFastPathInvalidAttemptError,
  WebRtcFastPathInvalidSdpError,
  WebRtcFastPathNegotiationError,
]);
export type WebRtcSignalingError = typeof WebRtcSignalingError.Type;
