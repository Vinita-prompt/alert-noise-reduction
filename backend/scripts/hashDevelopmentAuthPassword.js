const readline = require('node:readline');
const { hashDevelopmentPassword } = require('../src/services/authentication.service');

if (!process.stdin.isTTY) {
  console.error('Run this command in an interactive terminal. The password is never accepted as a command-line argument.');
  process.exit(1);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('Development operator password (12+ characters): ');
let password = '';

process.stdin.on('keypress', (character, key) => {
  if (key?.ctrl && key.name === 'c') {
    process.stdin.setRawMode(false);
    process.stdout.write('\n');
    process.exit(130);
  }
  if (key?.name === 'backspace') {
    password = password.slice(0, -1);
    return;
  }
  if (key?.name !== 'return') {
    if (character && !key?.ctrl && !key?.meta) password += character;
    return;
  }
  process.stdin.setRawMode(false);
  process.stdin.pause();
  try {
    console.log('\nPassword hash (safe to store in AUTH_DEVELOPMENT_USERS_JSON):');
    console.log(hashDevelopmentPassword(password));
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
});
