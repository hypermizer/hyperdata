import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const profile = process.env.HYPERDATA_AWS_PROFILE ?? "hyperdata-target-admin";
const region = "us-east-2",
  instance = "i-002f0a3f42574fe05",
  eni = "eni-0ce7cd8fb3d099693",
  privateIp = "10.140.10.12";
const directory = "/home/ubuntu/.config/hyperdata",
  path = `${directory}/infrastructure.json`;
const aws = (service, command, args = []) =>
  JSON.parse(
    execFileSync("aws", [
      service,
      command,
      ...args,
      "--profile",
      profile,
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }),
  );
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const identity = aws("sts", "get-caller-identity");
if (identity.Account !== "280911663188") {
  throw new Error(
    "Refusing infrastructure changes outside the migrated account 280911663188",
  );
}
await mkdir(directory, { recursive: true, mode: 0o700 });
let state = {};
try {
  state = JSON.parse(await readFile(path, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const save = () =>
  writeFile(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
const root = "vol-00828b5a937aa820a";
if (!state.rootSnapshot) {
  const result = aws("ec2", "create-snapshot", [
    "--volume-id",
    root,
    "--description",
    "Hyperdata pre-expansion 2026-11-09",
    "--tag-specifications",
    "ResourceType=snapshot,Tags=[{Key=Name,Value=hyperdata-before-root-expansion},{Key=ManagedBy,Value=Codex-OpenAI}]",
  ]);
  state.rootSnapshot = result.SnapshotId;
  await save();
}
const volume =
  aws("ec2", "describe-volumes", ["--volume-ids", root]).Volumes[0];
if (!volume.Attachments.some((a) => a.InstanceId === instance)) {
  throw new Error("Root disk attachment mismatch");
}
if (volume.Size < 240) {
  aws("ec2", "modify-volume", ["--volume-id", root, "--size", "240"]);
  console.log("Expanding root storage to 240 GiB");
}
for (let n = 0; n < 90; n++) {
  const rows =
    aws("ec2", "describe-volumes-modifications", ["--volume-ids", root])
      .VolumesModifications;
  if (
    !rows.length ||
    ["optimizing", "completed"].includes(rows[0].ModificationState)
  ) break;
  if (n === 89) {
    throw new Error("Volume expansion still pending; rerun this script later");
  }
  if (n % 6 === 0) console.log("Waiting for EBS root expansion");
  await pause(5000);
}
const rootBytes = Number(
  execFileSync("sudo", ["blockdev", "--getsize64", "/dev/nvme0n1"], {
    encoding: "utf8",
  }),
);
if (rootBytes < 240 * 1024 ** 3) {
  throw new Error("Expanded root block device is not yet visible");
}
try {
  run("sudo", ["growpart", "/dev/nvme0n1", "1"]);
} catch (e) {
  if (e.status !== 1) throw e;
}
run("sudo", ["resize2fs", "/dev/nvme0n1p1"]);
state.rootGiB = 240;
await save();
if (!state.dataVolume) {
  const v = aws("ec2", "create-volume", [
    "--availability-zone",
    "us-east-2a",
    "--size",
    "50",
    "--volume-type",
    "gp3",
    "--encrypted",
    "--kms-key-id",
    "arn:aws:kms:us-east-2:280911663188:key/70e270e0-b2cb-45dc-a177-417e92dce302",
    "--tag-specifications",
    "ResourceType=volume,Tags=[{Key=Name,Value=hyperdata-runtime-data},{Key=ManagedBy,Value=Codex-OpenAI},{Key=Purpose,Value=Hyperdata-alert-database}]",
  ]);
  state.dataVolume = v.VolumeId;
  await save();
}
for (let n = 0; n < 30; n++) {
  const v = aws("ec2", "describe-volumes", ["--volume-ids", state.dataVolume])
    .Volumes[0];
  if (v.Attachments.some((a) => a.InstanceId === instance)) break;
  if (v.State === "available") {
    aws("ec2", "attach-volume", [
      "--volume-id",
      state.dataVolume,
      "--instance-id",
      instance,
      "--device",
      "/dev/sdg",
    ]);
    break;
  }
  await pause(2000);
}
const device = `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${
  state.dataVolume.replace("-", "")
}`;
for (let n = 0; n < 30; n++) {
  try {
    execFileSync("test", ["-b", device]);
    break;
  } catch {
    if (n === 29) throw new Error("New data volume not visible");
    await pause(1000);
  }
}
let fs = "";
try {
  fs = execFileSync("sudo", ["blkid", "-o", "value", "-s", "TYPE", device], {
    encoding: "utf8",
  }).trim();
} catch {}
if (!fs) {
  run("sudo", ["mkfs.ext4", "-L", "hyperdata-runtime", device]);
  fs = "ext4";
}
if (fs !== "ext4") {
  throw new Error("Unexpected data filesystem; refusing to reformat");
}
run("sudo", ["mkdir", "-p", "/srv/hyperdata"]);
const uuid = execFileSync("sudo", [
  "blkid",
  "-o",
  "value",
  "-s",
  "UUID",
  device,
], { encoding: "utf8" }).trim();
const fstab = await readFile("/etc/fstab", "utf8");
if (!fstab.includes(`UUID=${uuid} `)) {
  execFileSync("sudo", ["tee", "-a", "/etc/fstab"], {
    input:
      `\nUUID=${uuid} /srv/hyperdata ext4 defaults,nofail,nodev,nosuid,noexec,x-systemd.device-timeout=30 0 2\n`,
    stdio: ["pipe", "ignore", "inherit"],
  });
}
run("sudo", ["systemctl", "daemon-reload"]);
try {
  execFileSync("mountpoint", ["-q", "/srv/hyperdata"]);
} catch {
  run("sudo", ["mount", "/srv/hyperdata"]);
}
if (!state.elasticIp) {
  const e = aws("ec2", "allocate-address", [
    "--domain",
    "vpc",
    "--tag-specifications",
    "ResourceType=elastic-ip,Tags=[{Key=Name,Value=hyperdata-private-runtime},{Key=ManagedBy,Value=Codex-OpenAI}]",
  ]);
  state.elasticIp = e.PublicIp;
  state.allocationId = e.AllocationId;
  await save();
}
const ips =
  aws("ec2", "describe-network-interfaces", ["--network-interface-ids", eni])
    .NetworkInterfaces[0].PrivateIpAddresses;
if (!ips.some((i) => i.PrivateIpAddress === privateIp)) {
  aws("ec2", "assign-private-ip-addresses", [
    "--network-interface-id",
    eni,
    "--private-ip-addresses",
    privateIp,
  ]);
}
const address =
  aws("ec2", "describe-addresses", ["--allocation-ids", state.allocationId])
    .Addresses[0];
if (
  address.PrivateIpAddress !== privateIp || address.NetworkInterfaceId !== eni
) {
  aws("ec2", "associate-address", [
    "--allocation-id",
    state.allocationId,
    "--network-interface-id",
    eni,
    "--private-ip-address",
    privateIp,
  ]);
}
const network = JSON.parse(
  execFileSync("ip", ["-j", "address", "show", "dev", "enp39s0"], {
    encoding: "utf8",
  }),
);
if (!network[0].addr_info.some((i) => i.local === privateIp)) {
  run("sudo", ["ip", "address", "add", `${privateIp}/24`, "dev", "enp39s0"]);
}
execFileSync("sudo", ["tee", "/etc/netplan/90-hyperdata-origin.yaml"], {
  input:
    `network:\n  version: 2\n  ethernets:\n    enp39s0:\n      addresses:\n        - ${privateIp}/24\n`,
  stdio: ["pipe", "ignore", "inherit"],
});
run("sudo", ["chmod", "600", "/etc/netplan/90-hyperdata-origin.yaml"]);
run("sudo", ["netplan", "generate"]);
state.privateIp = privateIp;
state.origin = `https://${state.elasticIp}`;
await save();
console.log(JSON.stringify(state, null, 2));
run("df", ["-h", "/", "/srv/hyperdata"]);
