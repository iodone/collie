// Secrets an agent asks for by name (collie-secret ask): the label on its terminal, and the
// words it hears when the person keeps or declines one (never the value). The window's masked
// card (secrets.js) writes to Collie's vault.

export const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
export const ASK = "collie.secret.ask.";

// What a terminal's labels ask for: [{ name, why }].
export function asksIn(labels) {
  const l = labels ?? {};
  return Object.keys(l).filter((k) => k.startsWith(ASK) && NAME.test(k.slice(ASK.length)) && l[k])
    .sort().map((k) => ({ name: k.slice(ASK.length), why: l[k] === "-" ? "" : String(l[k]) }));
}

// The agent hears it's kept, by name: never the value.
export const keptLine = (name, at) => `<hc from="person" secret="${name}">Kept: ${name} (for ${at}). Use it by name: collie-secret run ${name} -- <command>. Never print it or put it in a chat, brief, artifact or commit.</hc>`;

export const declinedLine = (name) => `<hc from="person" secret="${name}">Declined: ${name}. The person won't give it now: go on without it, or say plainly what you can't do without it. Don't ask for its value in the chat.</hc>`;
