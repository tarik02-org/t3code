import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { OpenCode2Runtime, OpenCode2RuntimeLive } from "./opencode2Runtime.ts";

const HEALTH_BODY = { healthy: true, version: "2.0.3", pid: 1234 };

/**
 * Records every request URL while answering the health probe. Recording the
 * request is the point: the external-server path used to normalize the
 * configured URL with `url.parse(...).toString()`, which evaluates to the
 * string "[object Object]" — the probe then requested "[object Object]/api/health"
 * and every external server looked unreachable. Asserting on the runtime's own
 * arguments would not have caught that.
 */
const makeTestLayer = (requestedUrls: Ref.Ref<ReadonlyArray<string>>) =>
  OpenCode2RuntimeLive.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requestedUrls, (urls) => [...urls, String(request.url)]).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, Response.json(HEALTH_BODY))),
          ),
        ),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const connectWithRequestLog = (serverUrl: string) =>
  Effect.gen(function* () {
    const requestedUrls = yield* Ref.make<ReadonlyArray<string>>([]);
    const exit = yield* OpenCode2Runtime.pipe(
      Effect.flatMap((runtime) => Effect.exit(runtime.connect({ serverUrl }))),
      Effect.provide(makeTestLayer(requestedUrls)),
    );
    return { exit, requestedUrls: yield* Ref.get(requestedUrls) };
  });

it.effect("probes an external server at its configured URL", () =>
  Effect.gen(function* () {
    const { exit, requestedUrls } = yield* connectWithRequestLog("http://127.0.0.1:49374");

    NodeAssert.equal(exit._tag, "Success");
    if (exit._tag !== "Success") return;
    NodeAssert.equal(exit.value.url, "http://127.0.0.1:49374");
    NodeAssert.equal(exit.value.version, "2.0.3");
    NodeAssert.deepEqual(requestedUrls, ["http://127.0.0.1:49374/api/health"]);
  }),
);

it.effect("keeps a trailing slash from corrupting the probe URL", () =>
  Effect.gen(function* () {
    const { requestedUrls } = yield* connectWithRequestLog("http://127.0.0.1:49374/");

    NodeAssert.equal(requestedUrls.length, 1);
    NodeAssert.ok(requestedUrls[0]?.includes("127.0.0.1:49374/api/health"));
    NodeAssert.ok(!requestedUrls[0]?.includes("[object Object]"));
  }),
);
