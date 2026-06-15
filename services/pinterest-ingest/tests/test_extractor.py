from pinterest_ingest.extractor import parse_gallery_dl_json


def test_parse_gallery_dl_json_prefers_pinimg_media_and_pin_url():
    output = """
{"id": "12345", "title": "Green reference", "description": "Palette", "post_url": "https://www.pinterest.com/pin/12345/", "image": {"url": "https://i.pinimg.com/originals/aa/bb/ref.jpg"}}
"""

    items = parse_gallery_dl_json("green-board", "https://www.pinterest.com/user/green-board/", output)

    assert len(items) == 1
    assert items[0]["external_id"] == "pinterest:green-board:12345"
    assert items[0]["image_url"] == "https://i.pinimg.com/originals/aa/bb/ref.jpg"
    assert items[0]["source_url"] == "https://www.pinterest.com/pin/12345/"


def test_parse_gallery_dl_json_accepts_resolve_json_message_array():
    output = """
[
  [1, "https://www.pinterest.com/example/reference-board/"],
  [
    2,
    {
      "id": "98765",
      "description": "Resolved message payload",
      "link": "https://www.pinterest.com/pin/98765/",
      "images": {
        "orig": {
          "url": "https://i.pinimg.com/originals/aa/bb/resolved.jpg",
          "width": 1200,
          "height": 1600
        },
        "236x": {
          "url": "https://i.pinimg.com/236x/aa/bb/resolved.jpg",
          "width": 236,
          "height": 314
        }
      }
    }
  ]
]
"""

    items = parse_gallery_dl_json("reference-board", "https://www.pinterest.com/example/reference-board/", output)

    assert len(items) == 1
    assert items[0]["external_id"] == "pinterest:reference-board:98765"
    assert items[0]["image_url"] == "https://i.pinimg.com/originals/aa/bb/resolved.jpg"
    assert items[0]["source_url"] == "https://www.pinterest.com/pin/98765/"


def test_parse_gallery_dl_json_skips_payload_without_media_url():
    output = '{"id": "12345", "post_url": "https://www.pinterest.com/pin/12345/"}'

    assert parse_gallery_dl_json("board", "https://www.pinterest.com/user/board/", output) == []
