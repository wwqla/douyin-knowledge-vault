// electron-builder afterPack：未购买 Apple 开发者证书时做 ad-hoc 签名。
// Apple 芯片上的应用必须带签名（哪怕是 ad-hoc）才能运行；未签名或签名失效会提示“已损坏”。
// ad-hoc 签名后首次打开仍会被拦截，到「系统设置 › 隐私与安全性」点「仍要打开」即可。
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
};
