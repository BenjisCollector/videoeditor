"""Wave 0 smoke test — proves pytest discovery + import path works.
Delete or extend when Wave 1+ lands real tests.
"""


def test_smoke_pytest_works() -> None:
    assert True


def test_smoke_can_import_fastapi() -> None:
    from fastapi import FastAPI

    app = FastAPI()
    assert app is not None
