"""Manual-only skills stay out of model discovery but work through the real slash loader."""
import json
from unittest.mock import patch

import pytest

from agent.prompt_builder import build_skills_system_prompt, clear_skills_system_prompt_cache
from agent.skill_commands import build_skill_invocation_message, scan_skill_commands
from tools import skills_tool


@pytest.mark.parametrize("flag", ["true", "false"])
def test_manual_skill_discovery_snapshot_and_explicit_load(tmp_path, monkeypatch, flag):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    skills = tmp_path / "skills"
    skill = skills / "manual-contract"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        f"---\nname: manual-contract\ndescription: Distinctive manual workflow.\n"
        f"disable-model-invocation: {flag}\n---\nPerform the requested manual workflow.\n"
    )
    clear_skills_system_prompt_cache(clear_snapshot=True)
    skills_tool.clear_skills_cache()
    with patch.object(skills_tool, "SKILLS_DIR", skills):
        first = build_skills_system_prompt(skills_dir_override=skills)
        clear_skills_system_prompt_cache()
        snapshot = build_skills_system_prompt(skills_dir_override=skills)
        assert first == snapshot
        assert ("manual-contract" in first) == (flag == "false")
        listed = json.loads(skills_tool.skills_list())
        assert ("manual-contract" in {s["name"] for s in listed["skills"]}) == (flag == "false")
        assert "/manual-contract" in scan_skill_commands()
        invocation = build_skill_invocation_message("/manual-contract", "check this")
        assert invocation is not None
        assert "Perform the requested manual workflow." in invocation
        assert "check this" in invocation
