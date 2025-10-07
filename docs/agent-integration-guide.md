# Agent Integration Guide

This guide explains how agents can use CAWS (Coding Agent Workflow System) as a quality bar for their iterative development work.

## Overview

CAWS provides agents with:

1. **Structured Quality Evaluation** - Machine-readable assessment of work quality
2. **Iterative Development Guidance** - Context-aware next steps and recommendations
3. **Risk-Appropriate Standards** - Tiered quality requirements based on project risk
4. **Contract Validation** - API and interface compliance checking
5. **Provenance Tracking** - Complete audit trail of agent decisions

## Getting Started

### Prerequisites
- CAWS CLI installed (`npm install -g @paths.design/caws-cli`)
- Valid working specification (`.caws/working-spec.yaml`)
- Project initialized with CAWS

### Basic Usage

```bash
# Check if working spec is ready for implementation
caws agent evaluate --feedback-only .caws/working-spec.yaml

# Evaluate current implementation progress
caws agent evaluate .caws/working-spec.yaml

# Get iterative development guidance
caws agent iterate --current-state '{"description": "Started core implementation"}' .caws/working-spec.yaml
```

## Agent Workflow Integration

### 1. Pre-Implementation Assessment

Before starting work, agents should validate the working spec:

```bash
# Get structured feedback on spec readiness
FEEDBACK=$(caws agent evaluate --feedback-only .caws/working-spec.yaml)

# Parse the JSON response
if [ "$(echo $FEEDBACK | jq -r '.success')" = "true" ]; then
    echo "Spec is ready for implementation"
    NEXT_ACTIONS=$(echo $FEEDBACK | jq -r '.evaluation.next_actions[]')
    echo "Next actions: $NEXT_ACTIONS"
else
    echo "Spec needs improvement"
    exit 1
fi
```

### 2. Iterative Development Loop

Agents should use CAWS throughout development:

```bash
#!/bin/bash

WORKING_SPEC=".caws/working-spec.yaml"
CURRENT_STATE="Started implementation"

while true; do
    echo "Evaluating current progress..."

    # Run quality evaluation
    RESULT=$(caws agent evaluate $WORKING_SPEC)
    SUCCESS=$(echo $RESULT | jq -r '.success')
    STATUS=$(echo $RESULT | jq -r '.evaluation.overall_status')

    if [ "$SUCCESS" = "true" ] && [ "$STATUS" = "quality_passed" ]; then
        echo "Quality standards met! Implementation complete."
        break
    fi

    # Get guidance for next iteration
    GUIDANCE=$(caws agent iterate --current-state "{\"description\": \"$CURRENT_STATE\"}" $WORKING_SPEC)

    # Extract next steps from guidance
    NEXT_STEPS=$(echo $GUIDANCE | jq -r '.iteration.next_steps[]')

    echo "Next steps to implement:"
    echo "$NEXT_STEPS" | while read -r step; do
        echo "  - $step"
    done

    # Agent would implement the next steps here
    # Then update CURRENT_STATE and repeat

    echo "Implementation iteration complete. Re-evaluating..."
    CURRENT_STATE="Completed iteration: $NEXT_STEPS"
done
```

### 3. Quality Gate Integration

Agents can integrate CAWS quality gates into their CI/CD:

```yaml
# .github/workflows/agent-development.yml
name: Agent Development Quality Gates

on:
  push:
    branches: [ main, develop ]

jobs:
  quality-gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup CAWS
        run: npm install -g @paths.design/caws-cli

      - name: Validate Working Spec
        run: caws validate .caws/working-spec.yaml

      - name: Run Quality Gates
        run: |
          RESULT=$(caws agent evaluate .caws/working-spec.yaml)
          SUCCESS=$(echo $RESULT | jq -r '.success')

          if [ "$SUCCESS" != "true" ]; then
            echo "Quality gates failed:"
            echo $RESULT | jq -r '.evaluation.criteria[] | select(.status == "failed") | "- \(.name): \(.feedback)"'
            exit 1
          fi

      - name: Generate Quality Report
        run: |
          caws agent evaluate .caws/working-spec.yaml > quality-report.json
          echo "## Quality Report" >> $GITHUB_STEP_SUMMARY
          echo "\`\`\`json" >> $GITHUB_STEP_SUMMARY
          cat quality-report.json >> $GITHUB_STEP_SUMMARY
          echo "\`\`\`" >> $GITHUB_STEP_SUMMARY
```

## API Reference

### Agent Evaluate Command

**Usage:**
```bash
caws agent evaluate [options] <spec-file>
```

**Options:**
- `--json`: Output structured JSON (default for agent use)
- `--strict`: Apply strict quality thresholds
- `--feedback-only`: Only validate spec, don't run quality gates

**Response Format:**
```json
{
  "success": boolean,
  "evaluation": {
    "overall_status": "spec_valid" | "quality_passed" | "quality_failed" | "error",
    "message": "Human-readable summary",
    "criteria": [
      {
        "id": "string",
        "name": "string",
        "status": "passed" | "failed" | "error",
        "score": number, // 0.0 to 1.0
        "weight": number, // Relative importance
        "feedback": "string" // Actionable guidance
      }
    ],
    "spec_summary": {
      "id": "string",
      "mode": "feature" | "refactor" | "fix",
      "tier": number, // 1-3 (risk level)
      "title": "string",
      "acceptance_criteria": number,
      "invariants": number
    },
    "next_actions": ["string"],
    "quality_score": number, // 0.0 to 1.0
    "risk_assessment": {
      "tier": number,
      "applied_thresholds": {
        "coverage": number,
        "mutation": number,
        "contracts": boolean
      },
      "risk_level": "high" | "medium" | "low",
      "recommendations": ["string"]
    }
  }
}
```

### Agent Iterate Command

**Usage:**
```bash
caws agent iterate [options] <spec-file>
```

**Options:**
- `--current-state <json>`: JSON description of current implementation state
- `--json`: Output structured JSON (default)

**Response Format:**
```json
{
  "success": boolean,
  "iteration": {
    "guidance": "string", // Human-readable guidance
    "next_steps": ["string"], // Specific actionable steps
    "confidence": number, // 0.0 to 1.0 confidence in guidance
    "focus_areas": ["string"], // Areas to prioritize
    "risk_mitigation": ["string"] // Risk mitigation suggestions
  }
}
```

## Agent Implementation Patterns

### Pattern 1: Quality-Driven Development

```javascript
class CawsGuidedAgent {
  async developFeature(workingSpecPath) {
    // Initial assessment
    const initialEval = await this.evaluateSpec(workingSpecPath);
    if (!initialEval.success) {
      throw new Error(`Spec validation failed: ${initialEval.evaluation.message}`);
    }

    let currentState = "Initial implementation started";
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      // Get guidance for current state
      const guidance = await this.getIterativeGuidance(workingSpecPath, currentState);

      // Execute recommended next steps
      await this.executeNextSteps(guidance.iteration.next_steps);

      // Evaluate progress
      const evaluation = await this.evaluateProgress(workingSpecPath);

      if (evaluation.success && evaluation.evaluation.overall_status === 'quality_passed') {
        console.log('✅ Feature implementation complete!');
        break;
      }

      // Update state for next iteration
      currentState = `Iteration ${iterations + 1}: ${guidance.iteration.next_steps.join(', ')}`;
      iterations++;
    }
  }

  async evaluateSpec(specPath) {
    const result = await exec(`caws agent evaluate --feedback-only ${specPath}`);
    return JSON.parse(result.stdout);
  }

  async getIterativeGuidance(specPath, currentState) {
    const result = await exec(`caws agent iterate --current-state '${JSON.stringify({description: currentState})}' ${specPath}`);
    return JSON.parse(result.stdout);
  }

  async evaluateProgress(specPath) {
    const result = await exec(`caws agent evaluate ${specPath}`);
    return JSON.parse(result.stdout);
  }

  async executeNextSteps(steps) {
    // Agent implements the recommended steps
    for (const step of steps) {
      console.log(`Implementing: ${step}`);
      // Implementation logic here
    }
  }
}
```

### Pattern 2: Risk-Aware Development

```javascript
class RiskAwareAgent {
  async assessAndMitigateRisks(specPath) {
    const evaluation = await this.evaluateSpec(specPath);
    const riskAssessment = evaluation.evaluation.risk_assessment;

    if (riskAssessment.tier === 1) {
      console.log('🔴 High-risk feature detected. Implementing extra safeguards...');

      // Add additional quality measures for high-risk features
      await this.implementExtraSecurity(specPath);
      await this.addComprehensiveTesting(specPath);
    }

    // Apply risk mitigation recommendations
    for (const recommendation of riskAssessment.recommendations) {
      await this.implementRecommendation(recommendation);
    }
  }

  async implementExtraSecurity(specPath) {
    // Implement security measures based on CAWS guidance
    const guidance = await this.getIterativeGuidance(specPath, "Implementing security measures");
    await this.executeNextSteps(guidance.iteration.risk_mitigation);
  }
}
```

## Best Practices for Agents

### 1. **Always Validate First**
- Check working spec validity before starting implementation
- Understand risk tier and quality requirements upfront

### 2. **Iterate with Feedback**
- Use CAWS evaluation after each significant implementation step
- Address failing criteria before proceeding
- Follow CAWS guidance for next steps

### 3. **Respect Risk Tiers**
- Higher risk features require more rigorous quality standards
- Implement appropriate testing and validation based on tier

### 4. **Handle Contract Requirements**
- Features must define contracts before implementation
- Validate contract compliance throughout development

### 5. **Maintain Quality Gates**
- Run quality gates regularly during development
- Don't proceed with failing quality criteria
- Use CAWS feedback to guide improvements

### 6. **Document Decision Rationale**
- Include CAWS evaluation results in commit messages
- Track which guidance influenced implementation decisions
- Maintain audit trail of quality improvements

## Troubleshooting

### Common Issues

**"Working spec file not found"**
- Ensure `.caws/working-spec.yaml` exists
- Check file permissions and path

**"Spec validation failed"**
- Review CAWS validation errors
- Use `caws validate --auto-fix` for automatic fixes
- Check required fields: id, title, risk_tier, mode, etc.

**"Quality gates failed"**
- Address failing criteria in order shown
- Implement missing tests or contracts
- Improve code quality based on feedback

**"Tool system not available"**
- Ensure `apps/tools/caws/` directory exists
- Check tool file permissions
- Validate tool implementations

### Getting Help

- Run `caws --help` for command overview
- Use `caws agent evaluate --help` for detailed options
- Check CAWS logs for detailed error information
- Review working spec against CAWS schema requirements

## Advanced Usage

### Custom Quality Thresholds

For specialized projects, you can implement custom quality thresholds:

```javascript
// Custom evaluation logic
async function customEvaluate(specPath, customThresholds) {
  const baseEvaluation = await evaluateSpec(specPath);

  // Apply custom business logic
  const adjustedScore = adjustScoreForBusinessRules(
    baseEvaluation.evaluation.quality_score,
    customThresholds
  );

  return {
    ...baseEvaluation,
    evaluation: {
      ...baseEvaluation.evaluation,
      quality_score: adjustedScore,
      custom_adjustments: customThresholds
    }
  };
}
```

### Integration with Agent Frameworks

CAWS can integrate with popular agent frameworks:

**LangChain Integration:**
```python
from langchain.agents import Tool
from langchain.utilities import BashProcess

class CawsEvaluationTool(Tool):
    name = "CAWS Quality Evaluation"
    description = "Evaluate code quality against CAWS standards"

    def _run(self, spec_path: str) -> str:
        import subprocess
        result = subprocess.run(
            ["caws", "agent", "evaluate", spec_path],
            capture_output=True, text=True
        )
        return result.stdout
```

**AutoGen Integration:**
```python
from autogen import AssistantAgent

caws_agent = AssistantAgent(
    name="CAWS_Quality_Assistant",
    system_message="""You are a quality assurance agent using CAWS standards.
    Always evaluate work against CAWS quality gates and provide guidance for improvement.""",
    tools=[caws_evaluation_tool]
)
```

This integration enables agents to use CAWS as their quality compass throughout the development process, ensuring consistent, high-quality outputs that meet organizational standards.
