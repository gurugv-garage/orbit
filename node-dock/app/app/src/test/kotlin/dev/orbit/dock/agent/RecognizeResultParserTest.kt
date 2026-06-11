package dev.orbit.dock.agent

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Test

/** Wire-shape handling for `recognize-result` — partial/odd frames degrade to
 *  "unknown", never throw (this runs inside the WS frame handler). */
class RecognizeResultParserTest {

    private fun parse(json: String) =
        RecognizeResultParser.parse(Json.parseToJsonElement(json).jsonObject)

    @Test
    fun fullFrameParses() {
        val (reqId, o) = parse(
            """{"reqId":"r1","name":"Guru","tentative":null,"confidence":0.42,"noFace":false,
                "people":[{"name":"Guru","tentative":null,"confidence":0.42,"side":"left"},
                          {"name":null,"tentative":"Shweta","confidence":0.3,"side":"right"}]}""",
        )
        assertThat(reqId).isEqualTo("r1")
        assertThat(o.name).isEqualTo("Guru")
        assertThat(o.tentative).isNull()
        assertThat(o.noFace).isFalse()
        assertThat(o.people).hasSize(2)
        assertThat(o.people[1].tentative).isEqualTo("Shweta")
        assertThat(o.people[1].side).isEqualTo("right")
    }

    @Test
    fun jsonNullNameIsNullNotTheStringNull() {
        val (_, o) = parse("""{"reqId":"r1","name":null,"tentative":"Guru","confidence":0.3,"noFace":false}""")
        assertThat(o.name).isNull()
        assertThat(o.tentative).isEqualTo("Guru")
    }

    @Test
    fun minimalFrameDegradesToUnknown() {
        val (reqId, o) = parse("""{}""")
        assertThat(reqId).isNull()
        assertThat(o.name).isNull()
        assertThat(o.tentative).isNull()
        assertThat(o.noFace).isFalse()
        assertThat(o.people).isEmpty()
    }

    @Test
    fun malformedPeopleEntriesAreSkipped() {
        val (_, o) = parse(
            """{"reqId":"r1","noFace":false,"people":[42,"x",{"side":"left"},{"name":"Guru","side":"center"}]}""",
        )
        assertThat(o.people).hasSize(2) // the two objects survive; junk skipped
        assertThat(o.people[0].name).isNull()
        assertThat(o.people[1].name).isEqualTo("Guru")
    }
}
