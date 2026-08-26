import { ensureSchema } from "./migrate-lib";

ensureSchema()
  .then(() => {
    console.log("Kaimi schema ready");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
