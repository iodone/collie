// Collie's always-on service (service/main.ts) will take over the background tick when its
// health/status lands in #9. Until then the window owns the tick; never start shepherdr's service
// from here.

let runs = false;

// Whether collie's service took the work over. False until #9 wires its health.
export const serviceRuns = () => runs;
