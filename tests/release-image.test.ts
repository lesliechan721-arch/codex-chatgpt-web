import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8")) as {
  jobs: Record<string, {
    needs?: string;
    outputs?: Record<string, string>;
    steps: Array<{
      id?: string;
      uses?: string;
      run?: string;
      env?: Record<string, string>;
      with?: Record<string, unknown>;
    }>;
  }>;
};

test("server image publication follows the successful Release and excludes build records from assets", () => {
  const publish = workflow.jobs.publish!;
  const image = workflow.jobs["publish-image"]!;
  expect(image.needs).toBe("publish");
  expect(publish.outputs?.image_latest).toBe("${{ steps.release.outputs.image_latest }}");
  expect(publish.steps.find(step => step.id === "release")?.run).toContain("--json isPrerelease");
  expect(publish.steps.find(step => step.uses?.startsWith("actions/download-artifact@"))?.with?.pattern)
    .toBe("release-*");
  const build = image.steps.find(step => step.uses?.startsWith("docker/build-push-action@"))!;
  expect(build.with).toMatchObject({
    context: ".", file: "deploy/server/Dockerfile", platforms: "linux/amd64", push: true,
    tags: "${{ steps.image.outputs.tags }}",
  });
});

test.skipIf(process.platform === "win32")("server image tags update latest only for a non-prerelease Release", () => {
  const tagsStep = workflow.jobs["publish-image"]!.steps.find(step => step.id === "image")!;
  expect(tagsStep.env?.PUBLISH_LATEST).toBe("${{ needs.publish.outputs.image_latest }}");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const scratch = mkdtempSync(join(tmpdir(), "release-image-tags-"));
  try {
    for (const publishLatest of ["true", "false"]) {
      const output = join(scratch, publishLatest);
      const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", tagsStep.run!], {
        cwd: root,
        env: { ...process.env, PUBLISH_LATEST: publishLatest, GITHUB_OUTPUT: output },
        stdout: "pipe", stderr: "pipe",
      });
      expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({ code: 0, error: "" });
      const tags = readFileSync(output, "utf8").trim().split("\n");
      expect(tags).toEqual([
        "tags<<EOF", `lesliechan721/codex-chatgpt-web:${version}`,
        ...(publishLatest === "true" ? ["lesliechan721/codex-chatgpt-web:latest"] : []), "EOF",
      ]);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
