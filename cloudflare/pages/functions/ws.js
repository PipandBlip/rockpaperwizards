// Pages Function: WebSocket relay for Rock, Paper, Wizards.
//
// The browser connects to /ws on the Pages site. This Function validates
// the WebSocket upgrade request, then forwards it to a single fixed
// Durable Object instance — everyone who connects lands in the same relay,
// which holds every room (matching how the Node relay worked: one process,
// all rooms).
//
// The Durable Object class itself can't live in a Pages project — it has
// to be defined and deployed as its own Worker (see
// cloudflare/worker/src/index.js), and this Function reaches it purely
// through the RPW_RELAY binding configured on the Pages project
// (Settings > Bindings > Durable Object, pointing at that worker's
// "RPWRelay" class — see cloudflare/pages/wrangler.toml).

const RELAY_NAME = 'main-relay';

export async function onRequestGet(context) {
  const upgradeHeader = context.request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  const id = context.env.RPW_RELAY.idFromName(RELAY_NAME);
  const stub = context.env.RPW_RELAY.get(id);

  // Hand the (still-unresolved) upgrade request straight to the Durable
  // Object; its own fetch() accepts the WebSocket and returns the 101
  // response, which passes back through untouched.
  return stub.fetch(context.request);
}
