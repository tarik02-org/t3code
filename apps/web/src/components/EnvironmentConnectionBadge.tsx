import { connectionStatusText, connectionStatusTitle } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { CableIcon, RadioTowerIcon } from "lucide-react";

import { useEnvironment } from "~/state/environments";
import { useEnvironmentRpcTransport } from "~/state/session";

import { Badge } from "./ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface EnvironmentConnectionBadgeProps {
  readonly environmentId: EnvironmentId;
}

export function EnvironmentConnectionBadge({ environmentId }: EnvironmentConnectionBadgeProps) {
  const environment = useEnvironment(environmentId);
  const transport = useEnvironmentRpcTransport(environmentId);
  const phase = environment?.connection.phase ?? "available";
  const status = environment ? connectionStatusTitle(environment.connection) : "Unavailable";
  const statusDetail = environment ? connectionStatusText(environment.connection) : status;
  const transportLabel =
    transport === "webrtc"
      ? "WebRTC DataChannel"
      : transport === "websocket"
        ? "WebSocket"
        : "Not connected";

  let variant: "error" | "secondary" | "success" | "warning" = "secondary";
  switch (phase) {
    case "connected":
      variant = "success";
      break;
    case "connecting":
    case "reconnecting":
      variant = "warning";
      break;
    case "error":
      variant = "error";
      break;
    case "available":
    case "offline":
      break;
  }

  const TransportIcon = transport === "webrtc" ? RadioTowerIcon : CableIcon;
  const badge = (
    <Badge
      variant={variant}
      size="sm"
      aria-label={`${status}. RPC transport: ${transportLabel}.`}
      className="size-5 px-0 sm:size-4"
    >
      <TransportIcon aria-hidden className="size-3 mx-0!" />
    </Badge>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipPopup side="top" className="max-w-80 text-left text-pretty">
        <dl className="grid min-w-52 grid-cols-[auto_1fr] gap-x-3 gap-y-1 py-0.5">
          <dt className="text-muted-foreground">Status</dt>
          <dd className="font-medium text-foreground">{statusDetail}</dd>
          <dt className="text-muted-foreground">RPC transport</dt>
          <dd className="font-medium text-foreground">{transportLabel}</dd>
          {transport !== null ? (
            <>
              <dt className="text-muted-foreground">Control channel</dt>
              <dd className="font-medium text-foreground">WebSocket</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Environment</dt>
          <dd className="font-medium text-foreground">{environment?.label ?? environmentId}</dd>
        </dl>
      </TooltipPopup>
    </Tooltip>
  );
}
