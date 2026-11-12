// Runs before `npm run setup` and `npm start` (the "presetup"/"prestart" scripts in package.json). Plain
// JavaScript on purpose: an older Node.js can't load the TypeScript files at all and would only report
// "Unknown file extension .ts", so this explains what to install instead.
const MIN_NODE = 24;
const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE) {
  console.error(`The Project Manager needs Node.js ${MIN_NODE} or newer, and this is Node.js ${process.versions.node}.`);
  console.error('Install the current LTS from https://nodejs.org (Windows: winget install OpenJS.NodeJS.LTS; macOS: brew install node),');
  console.error('then open a new terminal and run the command again.');
  process.exit(1);
}
