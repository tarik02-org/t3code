import {
  type AuthClientPresentationMetadata,
  type AuthEnvironmentScope,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { WebRtcDataChannelPort } from "@t3tools/shared/webrtcDataChannel";

import type { ConnectionAttemptError } from "../connection/model.ts";

export interface PreparedSshEnvironment {
  readonly bootstrap: DesktopSshEnvironmentBootstrap;
  readonly bearerToken: string;
}

export interface ProvisionedSshEnvironment extends PreparedSshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export class CloudSession extends Context.Service<
  CloudSession,
  {
    readonly clerkToken: Effect.Effect<string, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/CloudSession") {}

export class RelayDeviceIdentity extends Context.Service<
  RelayDeviceIdentity,
  {
    readonly deviceId: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/RelayDeviceIdentity") {}

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly metadata: AuthClientPresentationMetadata;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  }
>()("@t3tools/client-runtime/platform/capabilities/ClientPresentation") {}

export class PrimaryEnvironmentAuth extends Context.Service<
  PrimaryEnvironmentAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/PrimaryEnvironmentAuth") {}

export class SshEnvironmentGateway extends Context.Service<
  SshEnvironmentGateway,
  {
    readonly provision: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<ProvisionedSshEnvironment, ConnectionAttemptError>;
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: DesktopSshEnvironmentTarget;
    }) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError>;
    readonly disconnect: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/SshEnvironmentGateway") {}

export class WebRtcPeerError extends Schema.TaggedErrorClass<WebRtcPeerError>()("WebRtcPeerError", {
  stage: Schema.Literals(["create", "offer", "answer", "ice-gathering", "connection", "stats"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `WebRTC peer failed during ${this.stage}.`;
  }
}

export interface WebRtcPeer {
  readonly dataChannel: WebRtcDataChannelPort;
  readonly createOffer: Effect.Effect<string, WebRtcPeerError>;
  readonly acceptAnswer: (answerSdp: string) => Effect.Effect<void, WebRtcPeerError>;
  readonly closed: Effect.Effect<never, WebRtcPeerError>;
  readonly selectedIcePairType: Effect.Effect<string | null, WebRtcPeerError>;
  readonly close: Effect.Effect<void>;
}

export interface WebRtcPeerFactoryService {
  readonly create: (
    stunUrls: ReadonlyArray<string>,
  ) => Effect.Effect<WebRtcPeer, WebRtcPeerError, Scope.Scope>;
}

export class WebRtcPeerFactory extends Context.Reference<WebRtcPeerFactoryService | null>(
  "@t3tools/client-runtime/platform/capabilities/WebRtcPeerFactory",
  {
    defaultValue: () => null,
  },
) {}
