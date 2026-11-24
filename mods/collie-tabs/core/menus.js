// A tab's name in the tab bar: the name given, else (Herdr's own "tb3", or none) what runs in it, else "Terminal".
export const tabName = (name, program = null) => (!name || /^tb\d+$/.test(name) ? program || "Terminal" : name);
