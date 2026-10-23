//! Prints the inputs and outputs of an ONNX model: a check of the Parakeet files.
fn main() {
    let env = ort::init().build().unwrap();
    for path in std::env::args().skip(1) {
        let session = ort::session::Session::builder(&env).unwrap().commit_from_file(&path).unwrap();
        println!("== {path}");
        for i in session.inputs() {
            println!("  in  {} {:?}", i.name(), i.dtype());
        }
        for o in session.outputs() {
            println!("  out {} {:?}", o.name(), o.dtype());
        }
    }
}
