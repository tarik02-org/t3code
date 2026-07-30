import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2VisibleTurnItemPageInfo,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  readonly visibleTurnItemHistory?: {
    readonly page: OrchestrationV2VisibleTurnItemPageInfo | null;
    readonly loadingPrevious: boolean;
  };
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  visibleTurnItemHistory: {
    page: null,
    loadingPrevious: false,
  },
};
