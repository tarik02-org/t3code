import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Electron from "electron";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const INSTALL_HELPER = `#!/bin/sh
set -eu

reopen_bundle() {
  reopen_target="$1"
  reopen_elevated="$2"

  if [ "$reopen_elevated" = "true" ]; then
    console_uid="$(/usr/bin/stat -f '%u' /dev/console)"
    console_user="$(/usr/bin/id -nu "$console_uid")"
    /usr/bin/sudo -u "$console_user" /bin/launchctl asuser "$console_uid" /usr/bin/open "$reopen_target"
    return
  fi

  /usr/bin/open "$reopen_target"
}

replace_bundle() {
  replace_candidate="$1"
  replace_target="$2"
  replace_elevated="$3"
  replace_previous="\${replace_target}.previous"

  /bin/rm -rf "$replace_previous"
  if ! /bin/mv "$replace_target" "$replace_previous"; then
    reopen_bundle "$replace_target" "$replace_elevated" || true
    return 1
  fi

  if ! /bin/mv "$replace_candidate" "$replace_target"; then
    /bin/mv "$replace_previous" "$replace_target"
    reopen_bundle "$replace_target" "$replace_elevated" || true
    return 1
  fi

  if reopen_bundle "$replace_target" "$replace_elevated"; then
    /bin/rm -rf "$replace_previous"
    return 0
  fi

  /bin/rm -rf "$replace_target"
  /bin/mv "$replace_previous" "$replace_target"
  reopen_bundle "$replace_target" "$replace_elevated" || true
  return 1
}

if [ "\${1:-}" = "--replace-elevated" ]; then
  shift
  replace_bundle "$1" "$2" true
  exit $?
fi

running_pid="$1"
archive="$2"
target="$3"
helper_dir="$(/usr/bin/dirname "$0")"
stage="$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/t3code-update.XXXXXX")"

cleanup() {
  /bin/rm -rf "$stage"
  /bin/rm -f "$0"
  /bin/rmdir "$helper_dir" 2>/dev/null || true
}
trap cleanup EXIT

while /bin/kill -0 "$running_pid" 2>/dev/null; do
  /bin/sleep 1
done

if ! /usr/bin/ditto -x -k "$archive" "$stage"; then
  /usr/bin/open "$target" || true
  exit 1
fi

candidate="$(/usr/bin/find "$stage" -type d -name '*.app' -prune -print | /usr/bin/head -n 1)"
if [ -z "$candidate" ]; then
  /usr/bin/open "$target" || true
  exit 1
fi

/usr/bin/xattr -rd com.apple.quarantine "$candidate" 2>/dev/null || true

target_parent="$(/usr/bin/dirname "$target")"
if [ -w "$target_parent" ]; then
  replace_bundle "$candidate" "$target" false
  exit $?
fi

/usr/bin/osascript - "$0" "$candidate" "$target" <<'APPLESCRIPT'
on run argv
  set helperPath to item 1 of argv
  set candidatePath to item 2 of argv
  set targetPath to item 3 of argv
  do shell script "/bin/sh " & quoted form of helperPath & " --replace-elevated " & quoted form of candidatePath & " " & quoted form of targetPath with administrator privileges
end run
APPLESCRIPT
`;

export const makeInstallUnsignedMacUpdate = Effect.fn("makeInstallUnsignedMacUpdate")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return Effect.fn("installUnsignedMacUpdate")(function* (archivePath: string) {
    const executablePath = Electron.app.getPath("exe");
    const targetBundlePath = path.dirname(path.dirname(path.dirname(executablePath)));
    const helperDirectory = yield* fileSystem.makeTempDirectory({
      directory: Electron.app.getPath("temp"),
      prefix: "t3code-mac-update-",
    });
    const helperPath = path.join(helperDirectory, "install-update.sh");
    yield* fileSystem.writeFileString(helperPath, INSTALL_HELPER, { mode: 0o700 });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const helper = yield* childProcessSpawner.spawn(
          ChildProcess.make(
            "/bin/sh",
            [helperPath, String(process.pid), archivePath, targetBundlePath],
            {
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            },
          ),
        );
        yield* helper.unref.pipe(Effect.asVoid);
      }),
    );
    yield* Effect.sync(() => Electron.app.quit());
  });
});
