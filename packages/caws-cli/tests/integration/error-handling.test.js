/**
 * @fileoverview Integration tests for error handling paths
 * Tests error handling, recovery suggestions, and output formatting
 * @author @darianrosebrook
 */

const { commandWrapper, Output } = require('../utils/command-wrapper');
const { parallel, retry, withTimeout, withCleanup } = require('../utils/async-utils');

describe('Error Handling Integration', () => {
  describe('commandWrapper', () => {
    it('should handle errors gracefully', async () => {
      let errorHandled = false;
      const originalExit = process.exit;
      process.exit = () => {
        errorHandled = true;
      };

      try {
        await commandWrapper(
          async () => {
            throw new Error('Test error');
          },
          {
            commandName: 'test',
            exitOnError: false, // Don't exit in test
          }
        );
      } catch (error) {
        expect(error.message).toContain('Test error');
      }

      process.exit = originalExit;
    });

    it('should provide recovery suggestions', async () => {
      try {
        await commandWrapper(
          async () => {
            const error = new Error('File not found');
            error.code = 'ENOENT';
            throw error;
          },
          {
            commandName: 'test',
            exitOnError: false,
          }
        );
      } catch (error) {
        expect(error.suggestions).toBeDefined();
        expect(Array.isArray(error.suggestions)).toBe(true);
      }
    });

    it('should support JSON output mode', async () => {
      const originalFormat = process.env.CAWS_OUTPUT_FORMAT;
      process.env.CAWS_OUTPUT_FORMAT = 'json';

      try {
        const result = await commandWrapper(
          async () => {
            return { success: true, data: 'test' };
          },
          {
            commandName: 'test',
            exitOnError: false,
          }
        );
        expect(result).toBeDefined();
      } finally {
        if (originalFormat) {
          process.env.CAWS_OUTPUT_FORMAT = originalFormat;
        } else {
          delete process.env.CAWS_OUTPUT_FORMAT;
        }
      }
    });
  });

  describe('Output Utilities', () => {
    beforeEach(() => {
      // Clear output format for tests
      delete process.env.CAWS_OUTPUT_FORMAT;
    });

    it('should format success messages', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      Output.success('Test success');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should format error messages with suggestions', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      Output.error('Test error', ['Suggestion 1', 'Suggestion 2']);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should support JSON output mode', () => {
      process.env.CAWS_OUTPUT_FORMAT = 'json';
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      Output.success('Test');
      const calls = consoleSpy.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // Should output JSON
      consoleSpy.mockRestore();
      delete process.env.CAWS_OUTPUT_FORMAT;
    });
  });

  describe('Async Utilities', () => {
    describe('parallel', () => {
      it('should execute promises in parallel', async () => {
        const startTime = Date.now();
        const results = await parallel([
          () => new Promise((resolve) => setTimeout(() => resolve(1), 100)),
          () => new Promise((resolve) => setTimeout(() => resolve(2), 100)),
          () => new Promise((resolve) => setTimeout(() => resolve(3), 100)),
        ]);
        const duration = Date.now() - startTime;

        expect(results).toEqual([1, 2, 3]);
        // Should complete in ~100ms (parallel) not ~300ms (sequential)
        expect(duration).toBeLessThan(200);
      });

      it('should handle failures with failFast', async () => {
        await expect(
          parallel([
            () => Promise.resolve(1),
            () => Promise.reject(new Error('Test error')),
            () => Promise.resolve(3),
          ])
        ).rejects.toThrow('Test error');
      });

      it('should collect all results when failFast is false', async () => {
        const results = await parallel(
          [
            () => Promise.resolve(1),
            () => Promise.reject(new Error('Test error')),
            () => Promise.resolve(3),
          ],
          { failFast: false }
        );

        expect(results).toHaveLength(3);
        expect(results[0].success).toBe(true);
        expect(results[0].value).toBe(1);
        expect(results[1].success).toBe(false);
        expect(results[1].error.message).toBe('Test error');
        expect(results[2].success).toBe(true);
        expect(results[2].value).toBe(3);
      });
    });

    describe('retry', () => {
      it('should retry failed operations', async () => {
        let attempts = 0;
        const result = await retry(
          async () => {
            attempts++;
            if (attempts < 3) {
              throw new Error('Temporary failure');
            }
            return 'success';
          },
          { maxRetries: 3, initialDelay: 10 }
        );

        expect(result).toBe('success');
        expect(attempts).toBe(3);
      });

      it('should respect max retries', async () => {
        await expect(
          retry(
            async () => {
              throw new Error('Always fails');
            },
            { maxRetries: 2, initialDelay: 10 }
          )
        ).rejects.toThrow('Always fails');
      });
    });

    describe('withTimeout', () => {
      it('should resolve before timeout', async () => {
        const result = await withTimeout(
          new Promise((resolve) => setTimeout(() => resolve('success'), 50)),
          1000
        );
        expect(result).toBe('success');
      });

      it('should reject on timeout', async () => {
        await expect(
          withTimeout(
            new Promise((resolve) => setTimeout(() => resolve('success'), 200)),
            100,
            'Custom timeout message'
          )
        ).rejects.toThrow('Custom timeout message');
      });
    });

    describe('withCleanup', () => {
      it('should execute cleanup after success', async () => {
        let cleanupCalled = false;
        const result = await withCleanup(
          async () => 'success',
          async () => {
            cleanupCalled = true;
          }
        );

        expect(result).toBe('success');
        expect(cleanupCalled).toBe(true);
      });

      it('should execute cleanup after error', async () => {
        let cleanupCalled = false;
        try {
          await withCleanup(
            async () => {
              throw new Error('Test error');
            },
            async () => {
              cleanupCalled = true;
            }
          );
        } catch (error) {
          expect(error.message).toBe('Test error');
        }

        expect(cleanupCalled).toBe(true);
      });
    });
  });
});

