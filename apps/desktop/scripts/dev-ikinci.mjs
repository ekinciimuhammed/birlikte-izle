// Aynı bilgisayarda ikinci bir kopya açar (ayrı ayar klasörüyle): kendinle eşleşip denemek için.
import { spawn } from 'node:child_process';

const env = { ...process.env, BIRLIKTE_PROFILE: 'ikinci' };
delete env.ELECTRON_RUN_AS_NODE; // bazı ortamlar (VS Code eklentileri) Electron'u düz Node'a çeviriyor

spawn('npx electron-vite dev', { stdio: 'inherit', shell: true, env }).on('exit', (code) => process.exit(code ?? 0));
