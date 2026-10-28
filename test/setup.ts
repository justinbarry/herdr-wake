// The extension reads its herdr environment once, at module load, so it has to be in place before
// any test file imports it.
import * as os from "node:os";
import * as path from "node:path";

process.env.HERDR_ENV = "1";
process.env.HERDR_SOCKET_PATH = path.join(os.tmpdir(), `herdr-wake-test-${process.pid}.sock`);
process.env.HERDR_PANE_ID = "w1:p1";
process.env.HERDR_WORKSPACE_ID = "w1";
delete process.env.OMPCODE; // a nested omp must not arm over its parent; the tests act as the outermost one
