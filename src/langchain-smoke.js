import { runLangchainSmokeTest, getLangchainFeatureSet } from "./langchain.js";

const main = async () => {
  const features = getLangchainFeatureSet();
  const result = await runLangchainSmokeTest();

  console.log("langchain features", features);
  console.log("langchain smoke", result);

  if (!result.ok) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error("langchain smoke failed", error);
  process.exitCode = 1;
});
