import { expect, test } from "bun:test";

async function source(relativePath: string) {
  return Bun.file(new URL(relativePath, import.meta.url)).text();
}

function componentProps(viewer: string) {
  const start = viewer.indexOf("interface Props {");
  const end = viewer.indexOf("\n}\n\n// Stable identity", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return viewer.slice(start, end);
}

function invocation(sourceText: string, component: string, from = 0) {
  const start = sourceText.indexOf(`<${component}`, from);
  const end = sourceText.indexOf("\n", sourceText.indexOf("/>", start));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceText.slice(start, end);
}

test("SessionViewer receives its socket capabilities from context", async () => {
  const [viewer, app] = await Promise.all([
    source("./SessionViewer.tsx"),
    source("../App.tsx"),
  ]);
  const props = componentProps(viewer);
  expect(props).not.toContain("send:");
  expect(props).not.toContain("addHandler:");
  expect(props).toContain("setTyping:");
  expect(props).toContain("connected:");
  expect(viewer).toContain(
    'import { useSessionSocket } from "../hooks/useSessionSocket";',
  );
  expect(viewer).toContain("const { send, addHandler } = useSessionSocket();");

  const viewerInvocation = invocation(app, "SessionViewer");
  expect(viewerInvocation).not.toContain("send=");
  expect(viewerInvocation).not.toContain("addHandler=");
  expect(viewerInvocation).toContain("setTyping={socket.setTyping}");
  expect(viewerInvocation).toContain(
    "connected={socket.connected && !pendingSocket}",
  );
  expect(app).toContain(
    "const pendingSocket = surfaceId === pendingSessionId;",
  );
  expect(app).toContain("socket={sessionSocket}");
  expect(app).toContain("<SessionPaneProviders");
  expect(app).toContain(
    "const sessionSocket = pendingSocket\n      ? socket.sessionSocketIgnoringMessages\n      : socket.sessionSocket;",
  );
  expect(app).toContain(
    "renderSessionPane(\n                                    session,\n                                    socket,",
  );
  expect(app).toContain(
    "renderSessionPane(\n                            currentSession,\n                            mainSocket,",
  );
});

test("SessionViewer descendants no longer receive socket props", async () => {
  const [viewer, terminal] = await Promise.all([
    source("./SessionViewer.tsx"),
    source("./TerminalPanel.tsx"),
  ]);
  const prPanel = invocation(viewer, "PrPanel");
  expect(prPanel).not.toContain("send=");
  expect(prPanel).not.toContain("addHandler=");

  let shellStart = 0;
  for (let count = 0; count < 2; count += 1) {
    const shellPanel = invocation(viewer, "ShellPanel", shellStart);
    expect(shellPanel).not.toContain("send=");
    expect(shellPanel).not.toContain("addHandler=");
    shellStart = viewer.indexOf("<ShellPanel", shellStart) + shellPanel.length;
  }

  expect(terminal).toContain(
    "const { send, addHandler } = useSessionSocket();",
  );
  const shellProps = terminal.slice(
    terminal.indexOf("export function ShellPanel"),
    terminal.indexOf(") {", terminal.indexOf("export function ShellPanel")),
  );
  expect(shellProps).not.toContain("send:");
  expect(shellProps).not.toContain("addHandler:");
});

test("PrPanel keeps explicit socket injection for other hosts", async () => {
  const [prPanel, queue, reviews, workspace] = await Promise.all([
    source("./PrPanel.tsx"),
    source("./PrQueuePreview.tsx"),
    source("./Reviews.tsx"),
    source("./WorkspacePane.tsx"),
  ]);
  expect(prPanel).toContain(
    "const sessionSocket = useOptionalSessionSocket();",
  );
  expect(prPanel).toContain("const send = sendProp ?? sessionSocket?.send;");
  expect(prPanel).toContain(
    "const addHandler = addHandlerProp ?? sessionSocket?.addHandler;",
  );
  for (const host of [queue, reviews, workspace]) {
    const call = invocation(host, "PrPanel");
    expect(call).toContain("send={send}");
    expect(call).toContain("addHandler={addHandler}");
  }
});

test("useWebSocket exposes stable live and message-ignoring contexts", async () => {
  const hook = await source("../hooks/useWebSocket.ts");
  expect(hook).toContain(
    "const [sessionSocket] = useState<SessionSocket>(() => ({ send, addHandler }));",
  );
  expect(hook).toContain("const [sessionSocketIgnoringMessages]");
  expect(hook).toContain("addHandler: IGNORE_WS_MESSAGES");
  expect(hook).toContain("sessionSocketIgnoringMessages,");
});
