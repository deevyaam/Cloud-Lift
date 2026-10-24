const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Reads an extracted Google Takeout export from a folder on this computer.

async function* walk(root, rel = '') {
  for (const entry of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(root, child);
    else if (entry.isFile()) yield child;
  }
}

// Every file under root as { rel, dir, name, size }; dir is relative to root ('' at the top).
async function* files(root) {
  for await (const rel of walk(root)) {
    const { size } = await fsp.stat(path.join(root, rel));
    const slash = rel.lastIndexOf('/');
    yield { rel, dir: slash < 0 ? '' : rel.slice(0, slash), name: rel.slice(slash + 1), size };
  }
}

async function check(root) {
  let stat;
  try {
    stat = await fsp.stat(root);
  } catch {
    throw new Error('Folder not found on this computer');
  }
  if (!stat.isDirectory()) throw new Error('That path is a file, not a folder');
  const summary = { files: 0, bytes: 0, media: 0, sidecars: 0, archives: 0 };
  for await (const f of files(root)) {
    summary.files++;
    summary.bytes += f.size;
    if (/\.json$/i.test(f.name)) summary.sidecars++;
    else if (/\.(jpe?g|png|gif|webp|heic|heif|bmp|mp4|mov|m4v|avi|mkv|webm|3gp|mpg)$/i.test(f.name)) summary.media++;
    if (/\.(zip|tgz|tar\.gz)$/i.test(f.name)) summary.archives++;
  }
  return summary;
}

// A local file with the same { range, stream } shape as the OneDrive reader.
function fileReader(file) {
  return {
    async range(start, end) {
      const handle = await fsp.open(file, 'r');
      try {
        const buffer = Buffer.alloc(end - start + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    stream: async () => fs.createReadStream(file),
  };
}

const reader = (root, rel) => fileReader(path.join(root, rel));

module.exports = { files, check, reader, fileReader };
