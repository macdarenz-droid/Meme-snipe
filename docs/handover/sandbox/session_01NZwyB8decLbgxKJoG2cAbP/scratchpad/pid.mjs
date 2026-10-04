Object.defineProperty(process, 'pid', { value: Number(process.env.FAKE_PID), configurable: true });
