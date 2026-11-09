import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const state = JSON.parse(
  await readFile("/home/ubuntu/.config/hyperdata/infrastructure.json", "utf8"),
);
if (
  !/^\d+\.\d+\.\d+\.\d+$/.test(state.elasticIp) ||
  state.privateIp !== "10.140.10.12"
) throw new Error("Verified runtime IP addresses required");
const sudo = (args, options = {}) =>
  execFileSync("sudo", args, { stdio: "inherit", ...options });
const put = (path, body) =>
  execFileSync("sudo", ["tee", path], {
    input: body,
    stdio: ["pipe", "ignore", "inherit"],
  });
const acme =
  `server { listen ${state.privateIp}:80; server_name ${state.elasticIp}; location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; try_files $uri =404; } location / { return 404; } }\n`;
let hasCertificate = false;
try {
  execFileSync("sudo", [
    "test",
    "-f",
    `/etc/letsencrypt/live/${state.elasticIp}/fullchain.pem`,
  ]);
  hasCertificate = true;
} catch {}
put(
  "/usr/local/sbin/reload-hyperdata-tls",
  "#!/bin/sh\nset -eu\n/usr/sbin/nginx -t\n/bin/systemctl reload nginx\n",
);
sudo(["chmod", "755", "/usr/local/sbin/reload-hyperdata-tls"]);
if (!hasCertificate) {
  put("/etc/nginx/sites-available/hyperdata-runtime", acme);
  sudo([
    "ln",
    "-sfn",
    "/etc/nginx/sites-available/hyperdata-runtime",
    "/etc/nginx/sites-enabled/hyperdata-runtime",
  ]);
  sudo(["nginx", "-t"]);
  sudo(["systemctl", "reload", "nginx"]);
  sudo([
    "certbot",
    "certonly",
    "--non-interactive",
    "--agree-tos",
    "--webroot",
    "-w",
    "/var/www/certbot",
    "--preferred-profile",
    "shortlived",
    "--ip-address",
    state.elasticIp,
    "--cert-name",
    state.elasticIp,
    "--deploy-hook",
    "/usr/local/sbin/reload-hyperdata-tls",
  ]);
}
const template = await readFile("deploy/nginx-hyperdata.conf", "utf8");
put(
  "/etc/nginx/sites-available/hyperdata-runtime",
  template.replaceAll("PRIVATE_IP", state.privateIp).replaceAll(
    "PUBLIC_IP",
    state.elasticIp,
  ),
);
sudo([
  "ln",
  "-sfn",
  "/etc/nginx/sites-available/hyperdata-runtime",
  "/etc/nginx/sites-enabled/hyperdata-runtime",
]);
sudo(["nginx", "-t"]);
sudo(["systemctl", "reload", "nginx"]);
const configPath = "public/config.js";
let config = await readFile(configPath, "utf8");
config = config.replace(/\n  alertsRuntimeUrl:.*\n/, "\n").replace(
  "export const APP_CONFIG = {",
  `export const APP_CONFIG = {\n  alertsRuntimeUrl: ${
    JSON.stringify(state.origin)
  },`,
);
await writeFile(configPath, config);
console.log(`Configured private runtime origin ${state.origin}`);
