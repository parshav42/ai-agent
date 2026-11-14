import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  return new Promise((resolve, reject) => {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 });
    const testFile = path.resolve(__dirname, 'extension.test.js');

    mocha.addFile(testFile);

    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}
