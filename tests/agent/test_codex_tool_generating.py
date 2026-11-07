"""A Responses stream announces each function call before its arguments stream (a clarify batch can take
seconds). The assembler must name the tool then, as the chat-completions path does, so the UI shows
what is being written instead of sitting silent until tool.start."""

from types import SimpleNamespace as NS

from agent.codex_runtime import _consume_codex_event_stream


def _stream():
    call = NS(id="fc_1", type="function_call", call_id="call_1", name="clarify", arguments="", status="in_progress")
    done = NS(id="fc_1", type="function_call", call_id="call_1", name="clarify", arguments='{"questions": []}',
              status="completed")
    return [
        NS(type="response.created", response=NS(id="resp_1")),
        NS(type="response.output_item.added", output_index=0, item=call),
        NS(type="response.function_call_arguments.delta", item_id="fc_1", output_index=0, delta='{"questions": []}'),
        NS(type="response.output_item.done", output_index=0, item=done),
        NS(type="response.completed", response=NS(id="resp_1", status="completed", output=None,
                                                  usage=NS(input_tokens=1, output_tokens=1, total_tokens=2))),
    ]


def test_announced_function_call_names_the_tool_before_its_arguments():
    consumed = 0
    seen = []

    def events():
        nonlocal consumed
        for event in _stream():
            consumed += 1
            yield event

    # Fired on output_item.added (the 2nd frame), before the argument delta (the 3rd) is read.
    _consume_codex_event_stream(events(), model="m", on_tool_started=lambda name: seen.append((name, consumed)))
    assert seen == [("clarify", 2)]


def test_no_callback_is_fine():
    response = _consume_codex_event_stream(iter(_stream()), model="m")
    assert response.status == "completed"
