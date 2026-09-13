import * as Schema from "effect/Schema";

export class ProjectLaunchEnvProjectLookupError extends Schema.TaggedError<ProjectLaunchEnvProjectLookupError>()(
  "ProjectLaunchEnvProjectLookupError",
  {
    projectId: Schema.String,
    reason: Schema.Enum({ notFound: "notFound", statFailed: "statFailed" }),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "notFound"
      ? `Project not found: ${this.projectId}`
      : `Failed to stat project: ${this.projectId}`;
  }
}

export class ProjectLaunchEnvThreadLookupError extends Schema.TaggedError<ProjectLaunchEnvThreadLookupError>()(
  "ProjectLaunchEnvThreadLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Thread not found: ${this.threadId}`;
  }
}
