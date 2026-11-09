import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
const state = JSON.parse(
  await readFile("/home/ubuntu/.config/hyperdata/infrastructure.json", "utf8"),
);
if (!state.origin?.startsWith("https://")) {
  throw new Error("Private runtime origin required");
}
const sshArgs = [
  "-i",
  "/home/ubuntu/.ssh/server-migration-280911663188",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "ubuntu@100.73.178.46",
];
const remote = (command, input) =>
  execFileSync("ssh", [...sshArgs, command], {
    input,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
const putRemote = (path, body) => remote(`sudo tee ${path} >/dev/null`, body);
remote("sudo install -d -m 0700 /etc/hyperdata-health");
remote(
  'sudo openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=Hyperdata Health Check" -keyout /etc/hyperdata-health/client.key -out /etc/hyperdata-health/client.csr >/dev/null 2>&1',
);
const csr = remote("sudo cat /etc/hyperdata-health/client.csr");
execFileSync("sudo", ["tee", "/etc/hyperdata/health-client.csr"], {
  input: csr,
  stdio: ["pipe", "ignore", "pipe"],
});
execFileSync("sudo", ["tee", "/etc/hyperdata/health-client.ext"], {
  input:
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n",
  stdio: ["pipe", "ignore", "pipe"],
});
execFileSync("sudo", [
  "openssl",
  "x509",
  "-req",
  "-in",
  "/etc/hyperdata/health-client.csr",
  "-CA",
  "/etc/nginx/mtls/ca.crt",
  "-CAkey",
  "/etc/nginx/mtls/ca.key",
  "-set_serial",
  "0x" + randomBytes(16).toString("hex"),
  "-days",
  "365",
  "-sha256",
  "-extfile",
  "/etc/hyperdata/health-client.ext",
  "-out",
  "/etc/hyperdata/health-client.crt",
], { stdio: ["ignore", "ignore", "pipe"] });
const cert = execFileSync("sudo", ["cat", "/etc/hyperdata/health-client.crt"], {
  encoding: "utf8",
});
putRemote("/etc/hyperdata-health/client.crt", cert);
const fingerprint = execFileSync("sudo", [
  "openssl",
  "x509",
  "-in",
  "/etc/hyperdata/health-client.crt",
  "-noout",
  "-fingerprint",
  "-sha1",
], { encoding: "utf8" }).trim().split("=")[1].replaceAll(":", "");
const provider = Object.fromEntries(
  execFileSync("sudo", ["cat", "/etc/hyperdata/providers.env"], {
    encoding: "utf8",
  }).trim().split("\n").map((line) => {
    const i = line.indexOf("=");
    const v = line.slice(i + 1);
    return [line.slice(0, i), v.startsWith('"') ? JSON.parse(v) : v];
  }),
);
putRemote(
  "/etc/hyperdata-health/config.json",
  JSON.stringify({
    origin: state.origin,
    ntfy_url: provider.NTFY_BASE_URL,
    ntfy_topic: provider.NTFY_TOPIC,
  }),
);
remote(
  "sudo chmod 0600 /etc/hyperdata-health/client.key /etc/hyperdata-health/config.json",
);
const api =
  execFileSync("sudo", ["cat", "/etc/hyperdata/api.env"], { encoding: "utf8" })
    .split("\n").filter((line) => !line.startsWith("HEALTH_FINGERPRINTS="))
    .join("\n") + `HEALTH_FINGERPRINTS=${fingerprint}\n`;
execFileSync("sudo", ["tee", "/etc/hyperdata/api.env"], {
  input: api,
  stdio: ["pipe", "ignore", "pipe"],
});
execFileSync("sudo", ["systemctl", "restart", "hyperdata-api"]);
putRemote(
  "/usr/local/sbin/hyperdata-external-watchdog",
  await readFile("scripts/external-alert-watchdog.py", "utf8"),
);
remote("sudo chmod 0755 /usr/local/sbin/hyperdata-external-watchdog");
for (
  const file of [
    "hyperdata-external-watchdog.service",
    "hyperdata-external-watchdog.timer",
  ]
) {
  putRemote(
    `/etc/systemd/system/${file}`,
    await readFile(`scripts/systemd/${file}`, "utf8"),
  );
}
remote("sudo systemctl daemon-reload");
remote("sudo systemctl enable --now hyperdata-external-watchdog.timer");
console.log(
  remote(
    "sudo systemctl start hyperdata-external-watchdog.service; sudo journalctl -u hyperdata-external-watchdog.service -n 3 --no-pager",
  ),
);
console.log(
  "Independent controller monitor installed with a health-only client certificate.",
);
