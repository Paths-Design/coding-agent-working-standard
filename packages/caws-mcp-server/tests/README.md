# CAWS MCP Server Tests

## Overview

This directory contains tests for the CAWS MCP Server to ensure protocol compliance and functionality.

## Test Files

### protocol-compliance.test.js

Tests for MCP protocol adherence:
- Server initialization
- Tool listing and schemas
- Tool execution
- Resource management
- Error handling
- Performance benchmarks

## Running Tests

### All Tests
```bash
npm test
```

### Watch Mode
```bash
npm test -- --watch
```

### Coverage
```bash
npm test -- --coverage
```

### Specific Test File
```bash
npm test -- protocol-compliance.test.js
```

## Test Status

### ✅ Implemented
- [x] Server initialization tests
- [x] Tool listing validation
- [x] Basic tool execution
- [x] Error handling
- [x] Performance benchmarks

### 🚧 In Progress
- [ ] Full tool execution tests
- [ ] Resource read/write tests
- [ ] Integration with CLI tests
- [ ] Timeout handling

### 📋 Planned
- [ ] Concurrent request tests
- [ ] Memory leak tests
- [ ] Load testing
- [ ] Security tests
- [ ] Regression tests

## Test Requirements

### Prerequisites
- Node.js 18+
- CAWS CLI installed
- Jest test framework

### Setup
```bash
cd packages/caws-mcp-server
npm install
npm test
```

## Writing Tests

### Test Structure
```javascript
describe('Feature Name', () => {
  beforeAll(() => {
    // Setup
  });

  afterAll(() => {
    // Cleanup
  });

  it('should test specific behavior', () => {
    // Arrange
    // Act
    // Assert
  });
});
```

### Best Practices

1. **Isolation**: Each test should be independent
2. **Cleanup**: Always clean up resources
3. **Descriptive**: Use clear test names
4. **Fast**: Keep tests under 1 second when possible
5. **Focused**: One assertion per test

## CI/CD Integration

Tests run automatically on:
- Pull requests
- Commits to main branch
- Release builds

### GitHub Actions
```yaml
- name: Run Tests
  run: |
    cd packages/caws-mcp-server
    npm test
```

## Coverage Goals

| Metric | Target | Current |
|--------|--------|---------|
| Statements | 80% | TBD |
| Branches | 75% | TBD |
| Functions | 80% | TBD |
| Lines | 80% | TBD |

## Debugging Tests

### Verbose Output
```bash
npm test -- --verbose
```

### Single Test
```bash
npm test -- -t "test name pattern"
```

### Debug Mode
```bash
node --inspect-brk node_modules/.bin/jest --runInBand
```

## Contributing

See main CONTRIBUTING.md for:
- Code style guidelines
- Pull request process
- Review criteria

## Resources

- [Jest Documentation](https://jestjs.io/)
- [MCP Specification](https://modelcontextprotocol.io/)
- [CAWS Testing Guide](../../docs/guides/testing.md)


