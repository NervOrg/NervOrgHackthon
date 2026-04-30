import fs from 'node:fs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const envExample = fs.readFileSync('.env.example', 'utf8');
const gitignore = fs.readFileSync('.gitignore', 'utf8');

assert(
  !/^OPENAI_API_KEY=sk-[A-Za-z0-9_-]+/m.test(envExample),
  '.env.example must not contain a real OpenAI API key'
);
assert(
  /^OPENAI_API_KEY=sk$/m.test(envExample),
  '.env.example should keep OPENAI_API_KEY as the placeholder value "sk"'
);
assert(
  /^assets\/$/m.test(gitignore),
  '.gitignore must keep generated assets/ ignored'
);
assert(
  /^world\.json$/m.test(gitignore),
  '.gitignore must keep local world.json ignored'
);

console.log('OK integration guardrails');
